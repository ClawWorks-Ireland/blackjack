#!/usr/bin/env node
/**
 * Checks for F7 (bankroll graph, session vs all-time stats, CSV export) and
 * F10 (screen-reader announcements, focus management) in headless Chromium.
 * Usage: node f7_f10_check.js <snapshotDir> <outDir> [rounds=12]
 */
'use strict';
const fs = require('fs'), http = require('http'), path = require('path');
const { chromium } = require('./lib/browser');
const dir = path.resolve(process.argv[2]), out = path.resolve(process.argv[3]);
const ROUNDS = Number(process.argv[4] || 12);
fs.mkdirSync(out, { recursive: true });
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };
const srv = http.createServer((q, r) => {
  const f = path.join(dir, decodeURIComponent(q.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(q.url.split('?')[0]));
  if (!f.startsWith(dir)) { r.writeHead(403); r.end(); return; }
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'text/plain' }); r.end(d); });
});

srv.listen(0, '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${srv.address().port}/index.html`;
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const r = { checks: {}, errors };
  const ok = (name, pass, detail) => { r.checks[name] = { pass, ...(detail !== undefined ? { detail } : {}) }; };
  const txt = (s) => page.$eval(s, (e) => e.textContent.trim()).catch(() => null);
  const enabled = (s) => page.$eval(s, (e) => !e.disabled && !e.closest('[hidden]')).catch(() => false);
  const idle = async () => { for (let i = 0; i < 60; i++) { if (await enabled('#deal') || await enabled('#hit') || await enabled('#no-insure')) return; await page.waitForTimeout(100); } };
  const focused = () => page.evaluate(() => document.activeElement && document.activeElement.id);
  try {
    await page.goto(url);
    await page.evaluate(() => localStorage.clear()); await page.reload();

    // ---- play rounds, sampling announcements and focus ----
    const announces = [], focusAfterDeal = [], focusAfterRound = [];
    const bankrolls = [];
    for (let i = 0; i < ROUNDS; i++) {
      await idle();
      await page.fill('#bet', '10');
      await page.click('#deal');
      await page.waitForTimeout(1500); // let cards land and focus move
      announces.push(await txt('#announcer'));
      if (await enabled('#no-insure')) { focusAfterDeal.push({ want: 'insurance', got: await focused() }); await page.click('#no-insure'); await page.waitForTimeout(1200); }
      if (await enabled('#hit')) {
        const firstAction = await page.evaluate(() => ['hit', 'stand', 'double', 'split', 'surrender'].find((id) => { const b = document.getElementById(id); return b && !b.disabled; }));
        focusAfterDeal.push({ want: firstAction, got: await focused() });
      }
      let g = 0;
      while (await enabled('#stand') && g++ < 6) { await page.click('#stand'); await page.waitForTimeout(1200); }
      await idle(); await page.waitForTimeout(500);
      const wantRound = (await enabled('#rebet-1')) ? 'rebet-1' : 'deal';
      focusAfterRound.push({ want: wantRound, got: await focused() });
      bankrolls.push(await txt('#bankroll'));
    }
    const annOk = announces.filter((a) => a && /You:/.test(a) && /(of (spades|hearts|clubs|diamonds))/.test(a));
    ok('F10 cards announced after a deal', annOk.length === announces.length, { sample: announces.slice(0, 3), ok: annOk.length, of: announces.length });
    const dealFocusOk = focusAfterDeal.filter((f) => f.want === 'insurance' ? /insure/.test(f.got || '') : f.got === f.want);
    ok('F10 focus moves to first action after deal', dealFocusOk.length === focusAfterDeal.length, { bad: focusAfterDeal.filter((f) => !dealFocusOk.includes(f)).slice(0, 3), n: focusAfterDeal.length });
    const roundFocusOk = focusAfterRound.filter((f) => f.got === f.want || (f.want === 'rebet-1' && f.got === 'rebet'));
    ok('F10 focus moves to Rebet/Deal after a round', roundFocusOk.length === focusAfterRound.length, { bad: focusAfterRound.filter((f) => !roundFocusOk.includes(f)).slice(0, 3), n: focusAfterRound.length });

    // ---- F7 graph ----
    const graph = await page.evaluate(() => {
      const svg = document.getElementById('bank-graph'); const line = document.getElementById('bank-line');
      const pts = line ? (line.getAttribute('points') || line.getAttribute('d') || '') : '';
      return { label: svg && svg.getAttribute('aria-label'), caption: (document.getElementById('bank-caption') || {}).textContent, pts: pts.trim().split(/\s+|L|M/).filter(Boolean).length };
    });
    const endBank = bankrolls[bankrolls.length - 1];
    ok('F7 graph has points and a caption naming the end bankroll', graph.pts >= 2 && !!graph.caption && graph.caption.replace(/,/g, '').includes((endBank || '').replace(/,/g, '')), { ...graph, endBank });

    // ---- F7 session vs all time ----
    const sessRounds = await txt('#stat-rounds');
    await page.reload(); await idle();
    const sessAfter = await txt('#stat-rounds');
    await page.click('#scope-all');
    const allAfter = await txt('#stat-rounds');
    const allNet = await txt('#stat-net');
    ok('F7 session resets on reload, all time keeps rounds', sessRounds === String(ROUNDS) && sessAfter === '0' && allAfter === String(ROUNDS), { sessRounds, sessAfter, allAfter, allNet });
    const net = Number((allNet || '').replace('−', '-').replace(/[^0-9.-]/g, '')); // sign kept by the regex
    const bank = Number(((await txt('#bankroll')) || '').replace(/[^0-9.]/g, ''));
    ok('F7 all-time net matches bankroll change', Math.abs(Math.abs(net) - Math.abs(bank - 1000)) < 0.01 && Math.sign(net || 0) === Math.sign(bank - 1000), { allNet, bank });

    // ---- F7 CSV export ----
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.click('#export-csv')]);
    const file = path.join(out, 'history.csv'); await dl.saveAs(file);
    const rows = fs.readFileSync(file, 'utf8').split(/\r?\n\r?\n/)[0].trim().split(/\r?\n/); // F18 appends a "Shoe reports" section after a blank line
    const header = rows[0].split(',');
    const bi = header.findIndex((h) => /bankroll/i.test(h));
    const lastBank = bi >= 0 ? rows[rows.length - 1].split(',')[bi] : null;
    ok('F7 CSV has one row per round and ends at the bankroll', rows.length - 1 === ROUNDS && lastBank !== null && Math.abs(Number(lastBank) - bank) < 0.01, { header, dataRows: rows.length - 1, lastBank, bank, name: dl.suggestedFilename() });
    await page.screenshot({ path: path.join(out, 'f7-stats.png'), fullPage: true });
  } catch (e) { errors.push('HARNESS ' + e.message.split('\n')[0]); }
  await browser.close(); srv.close();
  console.log(JSON.stringify(r, null, 1));
});
