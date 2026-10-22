#!/usr/bin/env node
/**
 * F11 checks: installable PWA (manifest, icons, service worker, works offline
 * after first load) and the landscape phone layout (844x390).
 * Usage: node f11_check.js <snapshotDir> <outDir>
 */
'use strict';
const fs = require('fs'), http = require('http'), path = require('path');
const { chromium } = require('./lib/browser');
const dir = path.resolve(process.argv[2]), out = path.resolve(process.argv[3]);
fs.mkdirSync(out, { recursive: true });
const T = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => {
  const u = decodeURIComponent(q.url.split('?')[0]); const f = path.join(dir, u === '/' ? 'index.html' : u);
  if (!f.startsWith(dir)) { r.writeHead(403); r.end(); return; }
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200, { 'content-type': T[path.extname(f)] || 'application/octet-stream' }); r.end(d); });
});

srv.listen(0, '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${srv.address().port}/index.html`;
  const browser = await chromium.launch({ headless: true });
  const r = { checks: {}, errors: [] };
  const ok = (n, pass, detail) => { r.checks[n] = { pass, ...(detail !== undefined ? { detail } : {}) }; };
  try {
    // ---- manifest + icons ----
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => r.errors.push(e.message));
    await page.goto(url);
    const man = await page.evaluate(async () => {
      const link = document.querySelector('link[rel="manifest"]'); if (!link) return null;
      const m = await (await fetch(link.href)).json();
      const icons = await Promise.all(m.icons.map(async (i) => {
        const res = await fetch(new URL(i.src, link.href)); const b = await res.blob();
        const img = await createImageBitmap(b); return { src: i.src, sizes: i.sizes, ok: res.ok, w: img.width, h: img.height, purpose: i.purpose };
      }));
      return { name: m.name, display: m.display, start: m.start_url, icons };
    });
    const iconsOk = man && man.icons.every((i) => i.ok && `${i.w}x${i.h}` === i.sizes);
    ok('F11 manifest: standalone, 192 + 512 + maskable icons at their stated sizes', !!man && man.display === 'standalone' && iconsOk && man.icons.some((i) => i.purpose === 'maskable'), man);

    // ---- service worker + offline ----
    const sw = await page.evaluate(async () => { const reg = await navigator.serviceWorker.ready; return { scope: reg.scope, active: !!reg.active }; });
    await page.reload(); await page.waitForTimeout(500); // let the controlled page populate the cache
    const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
    ok('F11 service worker active and controlling the page', sw.active && controlled, { ...sw, controlled });
    await page.fill('#bet', '10'); await page.click('#deal'); await page.waitForTimeout(1200);
    const bankOnline = await page.textContent('#bankroll');
    await ctx.setOffline(true);
    await page.reload(); await page.waitForTimeout(800);
    const off = await page.evaluate(() => ({ title: document.title, deal: !!document.getElementById('deal'), bank: document.getElementById('bankroll').textContent, css: getComputedStyle(document.body).fontFamily }));
    // play a full round offline
    let playedOffline = false;
    try {
      for (let i = 0; i < 30 && !(await page.$eval('#deal', (e) => !e.disabled)); i++) {
        if (await page.$eval('#stand', (e) => !e.disabled)) await page.click('#stand');
        else if (await page.$eval('#no-insure', (e) => !e.disabled && !e.closest('[hidden]'))) await page.click('#no-insure');
        await page.waitForTimeout(200);
      }
      await page.fill('#bet', '10'); await page.click('#deal'); await page.waitForTimeout(1200);
      for (let i = 0; i < 30 && !(await page.$eval('#deal', (e) => !e.disabled)); i++) {
        if (await page.$eval('#stand', (e) => !e.disabled)) await page.click('#stand');
        else if (await page.$eval('#no-insure', (e) => !e.disabled && !e.closest('[hidden]'))) await page.click('#no-insure');
        await page.waitForTimeout(200);
      }
      playedOffline = /win|lose|push|bust|blackjack|dealer|surrender/i.test(await page.textContent('#message'));
    } catch (e) { r.errors.push('offline play: ' + e.message.split('\n')[0]); }
    ok('F11 offline: reload loads the game and a round plays', off.title === 'Blackjack' && off.deal && playedOffline, { ...off, bankOnline, playedOffline });
    await ctx.setOffline(false);
    await ctx.close();

    // ---- landscape phone 844x390 ----
    for (const [w, h] of [[844, 390], [932, 430], [667, 375]]) {
      const lp = await browser.newPage({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
      await lp.goto(url); await lp.evaluate(() => localStorage.clear()); await lp.reload();
      const idle = { deal: await lp.evaluate(() => document.getElementById('deal').getBoundingClientRect().bottom), vw: await lp.evaluate(() => document.documentElement.scrollWidth) };
      await lp.check('input[name="spots"][value="3"]'); await lp.fill('#bet', '10'); await lp.click('#deal'); await lp.waitForTimeout(600);
      if (await lp.$eval('#no-insure', (e) => !e.disabled && !e.closest('[hidden]')).catch(() => false)) { await lp.click('#no-insure'); await lp.waitForTimeout(400); }
      const mid = await lp.evaluate(() => {
        const box = (id) => { const e = document.getElementById(id); const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom) }; };
        const cards = [...document.querySelectorAll('#player-hands .card, #dealer-cards .card')].map((c) => c.getBoundingClientRect());
        return { hit: box('hit'), stand: box('stand'), dealer: box('dealer-cards'), hands: box('player-hands'), vw: document.documentElement.scrollWidth,
          cardsBelowFold: cards.filter((b) => b.bottom > innerHeight + 1).length, cards: cards.length, sy: scrollY };
      });
      await lp.screenshot({ path: path.join(out, `landscape-${w}x${h}.png`) });
      const pass = idle.deal <= h && mid.hit.bottom <= h && mid.stand.bottom <= h && mid.vw <= w && mid.cardsBelowFold === 0 && mid.sy === 0;
      ok(`F11 landscape ${w}x${h}: Deal, cards and Hit/Stand visible, no scroll`, pass, { idleDealBottom: Math.round(idle.deal), ...mid });
      await lp.close();
    }
  } catch (e) { r.errors.push('HARNESS ' + e.message.split('\n').slice(0, 3).join(' / ')); }
  await browser.close(); srv.close();
  console.log(JSON.stringify(r, null, 1));
});
