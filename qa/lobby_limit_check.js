// Browser checks for the lobby's table limit (#168): with --max-tables 1 a second
// player-created table is refused with a visible message that survives refreshes.
// Usage: node qa/lobby_limit_check.js <snapshot dir> <out dir> <port>
// Starts the snapshot's real live server on 127.0.0.1 with a temp data dir.
const { chromium } = require('./lib/browser');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SNAP = path.resolve(process.argv[2] || '.');
const OUT = process.argv[3] || '.';
const PORT = Number(process.argv[4] || 8767);
const checks = {};
const put = (k, pass, detail) => { checks[k] = { pass: !!pass, detail }; };
const errors = [];

function finish() {
  const report = { checks, errors };
  try { fs.writeFileSync(path.join(OUT, 'lobby_limit.json'), JSON.stringify(report, null, 1)); } catch (_) { /* out dir optional */ }
  console.log(JSON.stringify(report, null, 1));
  process.exit(errors.length || Object.values(checks).some((c) => !c.pass) ? 1 : 0);
}

function startServer(tmp) {
  const child = spawn(process.execPath, [path.join(SNAP, 'server', 'server.js'), '--max-tables', '1', '--port', String(PORT), '--host', '127.0.0.1', '--data', path.join(tmp, 'players.json')], { stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = new Promise((resolve, reject) => {
    let seen = '';
    const timer = setTimeout(() => reject(new Error(`server not ready after 10 s: ${seen.slice(-200)}`)), 10000);
    const onData = (d) => { seen += d; if (/Blackjack tables on port/.test(seen)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => { seen += d; });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}) before ready: ${seen.slice(-200)}`)); });
  });
  return { child, ready };
}

const names = (p, sel) => p.$$eval(`${sel} .table-card h3`, (els) => els.map((e) => e.textContent.trim()));
const text = (p, sel) => p.$eval(sel, (e) => e.textContent.trim());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitCard(p, sel, name, timeout) {
  try {
    await p.waitForFunction(([s, n]) => [...document.querySelectorAll(`${s} .table-card h3`)].some((h) => h.textContent.trim() === n), [sel, name], { timeout });
    return true;
  } catch (_) { return false; }
}

async function waitLimit(p, msgSel, timeout) {
  try {
    await p.waitForFunction((s) => document.querySelector(s).textContent.trim().startsWith('Table limit reached'), msgSel, { timeout });
    return true;
  } catch (_) { return false; }
}

// Create one table through `form`, then try a second; judge both (AC2, AC4).
async function firstAndSecond(p, kind, form, tables, msgSel, first, second) {
  await p.fill(`${form} [name=name]`, first);
  await p.click(`${form} button[type=submit]`);
  const appeared = await waitCard(p, tables, first, 2000);
  const msg1 = await text(p, msgSel);
  put(`${kind} first table`, appeared && msg1 === '', { appeared, msg: msg1 });

  await p.fill(`${form} [name=name]`, second);
  await p.click(`${form} button[type=submit]`);
  const shown = await waitLimit(p, msgSel, 2000);
  const msg2 = await text(p, msgSel);
  const list = await names(p, tables);
  put(`${kind} limit message`, shown && /1/.test(msg2) && !list.includes(second), msg2);
}

(async () => {
  const lobbyFile = path.join(SNAP, 'web', 'lobby.html');
  const serverFile = path.join(SNAP, 'server', 'server.js');
  const lobby = fs.existsSync(lobbyFile) ? fs.readFileSync(lobbyFile, 'utf8') : '';
  if (!fs.existsSync(serverFile) || !fs.readFileSync(serverFile, 'utf8').includes('--max-tables')) {
    console.log(JSON.stringify({ checks: {}, skipped: 'no --max-tables flag in this commit' }));
    process.exit(0);
  }
  if (!/id="new"/.test(lobby)) {
    console.log(JSON.stringify({ checks: {}, skipped: 'no New blackjack table form in this commit' }));
    process.exit(0);
  }
  const hasPoker = /id="new-poker"/.test(lobby);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lobby-limit-'));
  const { child, ready } = startServer(tmp);
  let browser;
  try {
    try { await ready; } catch (e) { errors.push(`HARNESS ${e.message}`); return; }
    browser = await chromium.launch({ headless: true });
    const p = await (await browser.newContext()).newPage();
    p.on('pageerror', (e) => errors.push(e.stack || String(e)));
    await p.goto(`http://127.0.0.1:${PORT}/web/lobby.html`);
    try {
      await p.waitForFunction(() => { const t = document.querySelector('#tables').textContent; return t.includes('Main table') && t.includes('Practice (with bots)'); }, null, { timeout: 5000 });
    } catch (_) { errors.push('HARNESS seeded blackjack cards not shown'); return; }

    await firstAndSecond(p, 'bj', '#new', '#tables', '#lobby-msg', 'QA first', 'QA second');

    // AC3: the message outlives at least one list refresh (the lobby polls).
    await sleep(3500);
    const msg = await text(p, '#lobby-msg');
    const list = await names(p, '#tables');
    let api = null;
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/tables`);
      const j = await r.json();
      api = { total: j.tables.length, created: j.tables.filter((t) => t.name === 'QA first' || t.name === 'QA second').length, names: j.tables.map((t) => t.name) };
    } catch (e) { api = { error: e.message }; }
    put('bj limit holds after refresh', msg.startsWith('Table limit reached') && list.length === 3 && api.total === 3 && api.created === 1, { msg, cards: list, api });

    if (hasPoker) await firstAndSecond(p, 'poker', '#new-poker', '#poker-tables', '#poker-msg', 'QA poker first', 'QA poker second');
  } catch (e) {
    errors.push(`HARNESS ${(e.stack || e.message).split('\n').slice(0, 3).join(' | ')}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.removeAllListeners('exit');
    child.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
    finish();
  }
})();
