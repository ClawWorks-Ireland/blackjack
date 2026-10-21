#!/usr/bin/env node
/**
 * Browser checks for F12 (chart dialog), F13 (drills don't touch bankroll/stats)
 * and F14 (mistake review line + "Mistakes cost" stat).
 * Usage: node f12_f14_ui_check.js <snapshotDir> <outDir>
 */
'use strict';
const fs = require('fs'), http = require('http'), path = require('path');
const { pagePath } = require('./lib/layout');
const { chromium } = require('./lib/browser');
const dir = path.resolve(process.argv[2]), out = path.resolve(process.argv[3]);
fs.mkdirSync(out, { recursive: true });
const T = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => {
  const u = decodeURIComponent(q.url.split('?')[0]); const f = path.join(dir, u.endsWith('/') ? u + 'index.html' : u);
  if (!f.startsWith(dir)) { r.writeHead(403); r.end(); return; }
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200, { 'content-type': T[path.extname(f)] || 'application/octet-stream' }); r.end(d); });
});

srv.listen(0, '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${srv.address().port}${pagePath(dir)}`;
  const browser = await chromium.launch({ headless: true });
  const r = { checks: {}, errors: [] };
  const ok = (n, pass, detail) => { r.checks[n] = { pass, ...(detail !== undefined ? { detail } : {}) }; };
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    page.on('pageerror', (e) => r.errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') r.errors.push(m.text()); });
    await page.goto(url); await page.evaluate(() => localStorage.clear()); await page.reload();
    const en = (s) => page.$eval(s, (e) => !e.disabled && !e.closest('[hidden]')).catch(() => false);
    const snap = () => page.evaluate(() => ({ bank: document.getElementById('bankroll').textContent, rounds: document.getElementById('stat-rounds').textContent, acc: document.getElementById('stat-accuracy').textContent }));

    // ---- F12: chart dialog via V ----
    await page.keyboard.press('v'); await page.waitForTimeout(300);
    const ch = await page.evaluate(() => {
      const d = document.getElementById('chart');
      const tables = [...document.querySelectorAll('#chart-tables table')];
      return {
        open: d.open, tables: tables.length,
        rows: tables.map((t) => t.querySelectorAll('tbody tr').length),
        headers: tables.every((t) => t.querySelectorAll('thead th').length >= 11 && t.querySelectorAll('tbody th').length >= 1),
        cellsPerRow: tables.map((t) => t.querySelector('tbody tr').querySelectorAll('td').length),
        rules: document.getElementById('chart-rules').textContent.trim(),
        legend: document.getElementById('chart-legend').textContent.replace(/\s+/g, ' ').trim().slice(0, 160),
        h16v10: (() => { const t = tables[0]; if (!t) return null; const row = [...t.querySelectorAll('tbody tr')].find((tr) => /16/.test(tr.querySelector('th').textContent)); return row ? row.querySelectorAll('td')[8].textContent.trim() : null; })(),
      };
    });
    await page.screenshot({ path: path.join(out, 'f12-chart.png') });
    ok('F12 V opens chart: 3 tables with row/column headers, 10 upcards', ch.open && ch.tables === 3 && ch.headers && ch.cellsPerRow.every((n) => n === 10), ch);
    ok('F12 hard 16 vs 10 shows surrender (6D S17 LS)', /^R/.test(ch.h16v10 || ''), { h16v10: ch.h16v10 });
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);

    // ---- F14: make a deliberate mistake, check review line and stat ----
    let review = null, mistakes = null, made = false;
    for (let i = 0; i < 40 && !made; i++) {
      for (let k = 0; k < 40 && !(await en('#deal')); k++) await page.waitForTimeout(50);
      await page.fill('#bet', '10'); await page.click('#deal'); await page.waitForTimeout(300);
      if (await en('#no-insure')) { await page.click('#no-insure'); await page.waitForTimeout(200); }
      if (!(await en('#hit'))) continue;
      await page.click('#hint'); await page.waitForTimeout(100);
      const hint = await page.textContent('#hint-text');
      // choose stand when hint says hit, else hit (off-chart either way)
      if (/: Hit\./.test(hint)) { await page.click('#stand'); made = true; }
      else if (/: Stand\./.test(hint)) { await page.click('#hit'); made = true; }
      let g = 0; while (!(await en('#deal')) && g++ < 60) { if (await en('#stand')) await page.click('#stand'); await page.waitForTimeout(80); }
      if (made) {
        await page.waitForTimeout(300);
        review = await page.evaluate(() => { const e = document.getElementById('review'); return e && !e.hidden ? e.textContent.replace(/\s+/g, ' ').trim() : null; });
        mistakes = await page.evaluate(() => { const dt = [...document.querySelectorAll('dt')].find((d) => /Mistakes cost/i.test(d.textContent)); return dt ? dt.nextElementSibling.textContent.trim() : null; });
      }
    }
    ok('F14 an off-chart move produces a review line with a % cost', !!review && /-?\d+(\.\d+)?% of your bet/.test(review), { review });
    ok('F14 "Mistakes cost" stat is non-zero after a mistake', !!mistakes && !/^\$?0(\.00)?\b/.test(mistakes.replace(/[^0-9.$-]/g, '')), { mistakes });

    // ---- F13: drills don't touch bankroll or stats ----
    for (let k = 0; k < 60 && !(await en('#deal')); k++) await page.waitForTimeout(50);
    const before = await snap();
    await page.keyboard.press('w'); await page.waitForTimeout(300);
    const drillOpen = await page.evaluate(() => document.getElementById('drill').open);
    let answered = 0;
    for (let i = 0; i < 15; i++) {
      for (const key of ['h', 's']) { await page.keyboard.press(key); await page.waitForTimeout(120); answered++; }
    }
    const drillText = await page.evaluate(() => document.getElementById('drill').textContent.replace(/\s+/g, ' ').slice(0, 300));
    await page.screenshot({ path: path.join(out, 'f13-drill.png') });
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    const after = await snap();
    ok('F13 W opens drills; answering 30 cards leaves bankroll and stats unchanged', drillOpen && JSON.stringify(before) === JSON.stringify(after), { before, after, answered, drillText });

    // ---- phone: chart and drill fit 390 wide ----
    const ph = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    await ph.goto(url);
    await ph.keyboard.press('v'); await ph.waitForTimeout(300);
    const pw = await ph.evaluate(() => ({ docW: document.documentElement.scrollWidth, dialogW: Math.round(document.getElementById('chart').getBoundingClientRect().width) }));
    await ph.screenshot({ path: path.join(out, 'f12-chart-phone.png') });
    ok('F12 chart on a 390px phone: no page overflow, dialog within screen', pw.docW <= 390 && pw.dialogW <= 390, pw);
    await ph.close();
  } catch (e) { r.errors.push('HARNESS ' + e.message.split('\n').slice(0, 3).join(' / ')); }
  await browser.close(); srv.close();
  console.log(JSON.stringify(r, null, 1));
});
