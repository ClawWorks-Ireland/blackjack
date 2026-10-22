#!/usr/bin/env node
/**
 * Live table server (CLA-111): agents and people sit at the same tables.
 * Plain HTTP + Server-Sent Events, no dependencies. Serves the web pages too.
 *
 *   node server/server.js [--port 8787] [--host 0.0.0.0] [--data server/data/players.json] [--log server/data/requests.log]
 *
 * Listens on the home network by default (every interface of this machine);
 * --host 127.0.0.1 keeps it to this machine. It is not meant to face the
 * internet as it is: there are no accounts, and player kinds are
 * self-reported.
 *
 * API (JSON in, JSON out; a player token goes in the body, as
 * "Authorization: Bearer <token>", or as ?token= for the event stream):
 *
 *   GET  /api/tables                       tables, their seats and players
 *   POST /api/tables                       {name, rules, minBet, maxBet, bots, turnSeconds, betSeconds} -> table
 *   GET  /api/tables/:id                   the table as you see it (?token= for your seat)
 *   GET  /api/tables/:id/events            Server-Sent Events: "state" with your view after every change
 *   GET  /api/tables/:id/wait?since=V      long poll: returns when it is your move or the table passes version V
 *   POST /api/tables/:id/join              {name, kind: "ai"|"human", seat?} -> {token, seat}
 *   POST /api/tables/:id/bet               {amount}
 *   POST /api/tables/:id/sit-out           {}
 *   POST /api/tables/:id/act               {action: hit|stand|double|split|surrender|insurance|decline_insurance}
 *   POST /api/tables/:id/leave             {}
 *   GET  /api/leaderboard                  ?kind=ai|human: players ranked by units won per 100 rounds
 */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Hub, HubError } = require('./hub.js');
const { Leaderboard } = require('./leaderboard.js');

const ROOT = path.resolve(__dirname, '..');
const STATIC = ['web', 'engine'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 16384) { reject(new HubError('Request too large', 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { reject(new HubError('Body is not valid JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  const top = rel.split('/')[0];
  if (!STATIC.includes(top)) return false;
  const file = path.resolve(ROOT, rel.endsWith('/') ? `${rel}index.html` : rel);
  if (!file.startsWith(path.join(ROOT, top) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
  return true;
}

function createServer({ hub, log = () => {}, logRequests = null }) {
  const server = http.createServer(async (req, res) => {
    if (logRequests) {
      const t0 = Date.now();
      res.on('finish', () => logRequests(`${req.socket.remoteAddress} ${req.method} ${req.url.replace(/token=[0-9a-f]+/, 'token=…')} ${res.statusCode} ${Date.now() - t0}ms ${req.headers['user-agent'] || ''}`));
      if ((req.url || '').includes('/events')) logRequests(`${req.socket.remoteAddress} ${req.method} ${req.url.replace(/token=[0-9a-f]+/, 'token=…')} stream opened`);
    }
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/play')) {
        res.writeHead(302, { location: '/web/lobby.html' });
        return res.end();
      }
      if (parts[0] !== 'api') {
        if (req.method === 'GET' && serveStatic(req, res, url.pathname)) return;
        return send(res, 404, { error: 'Not found' });
      }
      const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null;
      if (parts[1] === 'leaderboard' && req.method === 'GET') {
        const kind = url.searchParams.get('kind');
        if (!hub.leaderboard) return send(res, 200, { players: [], byKind: {} });
        return send(res, 200, { players: hub.leaderboard.rows({ kind: kind === 'ai' || kind === 'human' ? kind : null }), byKind: hub.leaderboard.byKind(), minRounds: hub.leaderboard.minRounds });
      }
      if (parts[1] !== 'tables') return send(res, 404, { error: 'Not found' });
      if (parts.length === 2) {
        if (req.method === 'GET') return send(res, 200, { tables: hub.list() });
        if (req.method === 'POST') {
          const b = await readBody(req);
          const lt = hub.create({
            name: b.name, rules: b.rules || {}, minBet: b.minBet ?? 10, maxBet: b.maxBet ?? 500, bots: b.bots ?? 0,
            ...(b.turnSeconds ? { turnSeconds: Math.min(120, Math.max(5, Number(b.turnSeconds))) } : {}),
            ...(b.betSeconds ? { betSeconds: Math.min(120, Math.max(5, Number(b.betSeconds))) } : {}),
          });
          log(`table ${lt.id} created: ${lt.name}`);
          return send(res, 201, lt.summary());
        }
      }
      const lt = hub.get(parts[2]);
      const verb = parts[3] || '';
      if (req.method === 'GET') {
        const tok = url.searchParams.get('token') || bearer;
        if (verb === '') return send(res, 200, lt.view(tok));
        if (verb === 'events') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
          res.write('retry: 2000\n\n');
          const stop = lt.subscribe(tok, (view) => res.write(`event: state\ndata: ${JSON.stringify(view)}\n\n`));
          const beat = setInterval(() => res.write(': keep-alive\n\n'), 20000);
          req.on('close', () => { clearInterval(beat); stop(); });
          return;
        }
        if (verb === 'wait') {
          const since = url.searchParams.has('since') ? Number(url.searchParams.get('since')) : undefined;
          const timeout = Number(url.searchParams.get('timeout') || 25) * 1000;
          return send(res, 200, await lt.wait(tok, since, timeout));
        }
      }
      if (req.method === 'POST') {
        const b = await readBody(req);
        const tok = b.token || bearer;
        if (verb === 'join') {
          const joined = lt.join({ name: b.name, kind: b.kind, seat: b.seat });
          log(`table ${lt.id}: ${b.kind} "${b.name}" sat at seat ${joined.seat}`);
          return send(res, 200, { ...joined, view: lt.view(joined.token) });
        }
        if (verb === 'bet') lt.bet(tok, b.amount);
        else if (verb === 'sit-out') lt.sitOut(tok);
        else if (verb === 'act') lt.act(tok, b.action);
        else if (verb === 'leave') { lt.leave(tok); return send(res, 200, { ok: true }); }
        else return send(res, 404, { error: 'Not found' });
        return send(res, 200, lt.view(tok));
      }
      return send(res, 405, { error: 'Method not allowed' });
    } catch (e) {
      if (e instanceof HubError) return send(res, e.status, { error: e.message });
      log(`error: ${e.stack || e.message}`);
      return send(res, 500, { error: 'Server error' });
    }
  });
  // Requests that aren't HTTP at all (a browser trying HTTPS on this port, say) never reach the handler.
  server.on('clientError', (err, socket) => {
    if (logRequests) logRequests(`${socket.remoteAddress} not HTTP: ${err.code || err.message}`);
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
  });
  if (logRequests) server.on('connection', (s) => logRequests(`${s.remoteAddress} connected`));
  return server;
}

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
}

function main(argv) {
  const flag = (name, def) => { const i = argv.indexOf(name); return i === -1 ? def : argv[i + 1]; };
  const port = Number(flag('--port', 8787));
  const host = flag('--host', '0.0.0.0');
  const data = path.resolve(flag('--data', path.join(__dirname, 'data', 'players.json')));
  const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
  const leaderboard = new Leaderboard({ file: data });
  const hub = new Hub({ leaderboard, log });
  hub.create({ name: 'Main table', minBet: 10, maxBet: 500 });
  hub.create({ name: 'Practice (with bots)', minBet: 10, maxBet: 500, bots: 3 });
  const logFile = flag('--log', null) && path.resolve(flag('--log'));
  if (logFile) fs.mkdirSync(path.dirname(logFile), { recursive: true });
  let logFailed = false;
  const logRequests = logFile ? (m) => fs.appendFile(logFile, `${new Date().toISOString()} ${m}\n`, (e) => {
    if (e && !logFailed) { logFailed = true; console.error(`request log: can't write ${logFile}: ${e.message}`); }
  }) : null;
  const server = createServer({ hub, log, logRequests });
  server.listen(port, host, () => {
    console.log(`Blackjack tables on port ${port}`);
    if (host === '0.0.0.0') {
      console.log(`  this Mac:      http://localhost:${port}/`);
      for (const a of lanAddresses()) console.log(`  home network:  http://${a}:${port}/`);
    } else {
      console.log(`  only at:       http://${host}:${port}/`);
    }
    console.log(`  leaderboard data: ${path.relative(process.cwd(), data)}`);
    if (logFile) console.log(`  request log: ${path.relative(process.cwd(), logFile)}`);
  });
  const stop = () => { hub.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1000).unref(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { createServer };
