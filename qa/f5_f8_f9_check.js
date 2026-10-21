#!/usr/bin/env node
/**
 * UI checks for F5 (1-3 spots), F8 (settings: speed, volume, table, card back)
 * and F9 (rules + payouts overlay) in headless Chromium. Also screenshots the
 * 3-spot table on a 390x844 phone.
 * Usage: node f5_f8_f9_check.js <snapshotDir> <outDir>
 */
'use strict';
const fs = require('fs'), http = require('http'), path = require('path');
const { pagePath } = require('./lib/layout');
const { chromium } = require('./lib/browser');
const dir = path.resolve(process.argv[2]), out = path.resolve(process.argv[3]);
fs.mkdirSync(out, { recursive: true });
const T = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
const srv = http.createServer((q, r) => {
  const u = decodeURIComponent(q.url.split('?')[0]); const f = path.join(dir, u.endsWith('/') ? u + 'index.html' : u);
  if (!f.startsWith(dir)) { r.writeHead(403); r.end(); return; }
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200, { 'content-type': T[path.extname(f)] || 'text/plain' }); r.end(d); });
});
const money = (s) => Number(String(s || '').replace(/[^0-9.-]/g, ''));

srv.listen(0, '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${srv.address().port}${pagePath(dir)}`;
  const browser = await chromium.launch({ headless: true });
  const r = { checks: {}, errors: [] };
  const ok = (n, pass, detail) => { r.checks[n] = { pass, ...(detail !== undefined ? { detail } : {}) }; };
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', (e) => r.errors.push(e.message));
    await page.goto(url); await page.evaluate(() => localStorage.clear()); await page.reload();
    const en = (s) => page.$eval(s, (e) => !e.disabled && !e.closest('[hidden]')).catch(() => false);
    const idle = async () => { for (let i = 0; i < 80; i++) { if (await en('#deal') || await en('#hit') || await en('#no-insure')) return; await page.waitForTimeout(100); } };

    // ---- F5: 3 spots, each $10, stand everything ----
    const f5 = [];
    for (let round = 0; round < 8; round++) {
      await idle();
      await page.check('input[name="spots"][value="3"]');
      await page.fill('#bet', '10');
      const before = money(await page.textContent('#bankroll'));
      await page.click('#deal'); await page.waitForTimeout(1500);
      const inPlay = await page.textContent('#bet-display').catch(() => '');
      if (await en('#no-insure')) { await page.click('#no-insure'); await page.waitForTimeout(1200); }
      const activeOrder = [];
      let g = 0;
      // Play until the round is over (Deal usable again); Stand is briefly disabled between spots while cards land.
      while (!(await en('#deal')) && g++ < 200) {
        if (await en('#no-insure')) { await page.click('#no-insure'); continue; }
        if (await en('#stand')) {
          activeOrder.push(await page.evaluate(() => { const a = document.querySelector('#player-hands .player-hand.active'); return a ? [...document.querySelectorAll('#player-hands .player-hand')].indexOf(a.closest('.player-hand') || a) : -1; }));
          await page.click('#stand');
        }
        await page.waitForTimeout(150);
      }
      await page.waitForTimeout(600);
      const after = money(await page.textContent('#bankroll'));
      const hands = await page.$$eval('#player-hands .player-hand', (els) => els.length);
      const msg = (await page.textContent('#message')).trim();
      const hist = await page.$eval('#history li .net', (e) => e.textContent.trim()).catch(() => null);
      f5.push({ hands, inPlay: (inPlay || '').trim(), delta: after - before, hist, msg: msg.slice(0, 80), activeOrder });
    }
    const handsOk = f5.every((x) => x.hands === 3);
    const inPlayOk = f5.every((x) => /\$30/.test(x.inPlay));
    const histOk = f5.every((x) => x.hist === null || Math.abs(money(x.hist) * (/[-−]/.test(x.hist) ? -1 : 1) - x.delta) < 0.01 || Math.abs(money(x.hist) - x.delta) < 0.01);
    const orderOk = f5.every((x) => x.activeOrder.every((v, k, arr) => k === 0 || v === -1 || arr[k - 1] === -1 || v >= arr[k - 1]));
    ok('F5 three spots dealt, $30 in play', handsOk && inPlayOk, f5.slice(0, 2));
    ok('F5 history net equals bankroll change', histOk, f5.map((x) => [x.hist, x.delta]));
    ok('F5 spots played left to right', orderOk, f5.map((x) => x.activeOrder));
    ok('F5 result message covers every spot', f5.every((x) => /Hand 1|Spot 1|3 hands|Net/.test(x.msg) || x.hands < 2), f5.map((x) => x.msg).slice(0, 3));

    // ---- F9: overlay lists rules, main payouts and side paytables with edges ----
    await page.click('#help-open'); await page.waitForTimeout(300);
    const help = await page.evaluate(() => ({
      open: document.getElementById('help').open,
      rules: document.getElementById('help-rules').textContent.trim(),
      main: [...document.querySelectorAll('#help-payouts tr')].map((t) => t.textContent.replace(/\s+/g, ' ').trim()),
      sides: [...document.querySelectorAll('#help-sides tr')].map((t) => t.textContent.replace(/\s+/g, ' ').trim()),
    }));
    const mainTxt = help.main.join(' | '), sideTxt = help.sides.join(' | ');
    ok('F9 overlay shows rules and house edge', help.open && /edge/i.test(help.rules + mainTxt), help.rules.slice(0, 200));
    ok('F9 main payouts: 3:2, insurance 2:1, surrender half', /3:2/.test(mainTxt) && /2:1/.test(mainTxt) && /half|50%/i.test(mainTxt), help.main);
    ok('F9 side paytables 25/12/6 and 100/40/30/10/5 with edges', ['25', '12', '6', '100', '40', '30', '10', '5'].every((n) => new RegExp(`\\b${n}:1\\b|\\b${n} to 1\\b`).test(sideTxt)) && /6\.11/.test(sideTxt) && /4\.62/.test(sideTxt), help.sides);
    await page.keyboard.press('Escape');
    // rule change reflected in overlay
    await page.click('#rules-open'); await page.waitForTimeout(200);
    await page.check('input[name="soft17"][value="h17"]');
    await page.click('#set-apply'); await page.waitForTimeout(300);
    await page.click('#help-open'); await page.waitForTimeout(200);
    const rulesH17 = await page.textContent('#help-rules');
    ok('F9 overlay follows a rule change (H17)', /hits soft 17/i.test(rulesH17), rulesH17.slice(0, 160));
    await page.keyboard.press('Escape');

    // ---- F8: settings apply and persist ----
    await page.click('#prefs-open'); await page.waitForTimeout(200);
    await page.selectOption('#pref-speed', 'off');
    await page.selectOption('#pref-table', 'blue');
    await page.selectOption('#pref-back', 'red');
    await page.$eval('#pref-volume', (e) => { e.value = '30'; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.click('#prefs-close'); await page.waitForTimeout(200);
    const look = async () => {
      // Read what the game applied and saved; the slider is only refilled when Settings opens.
      await page.click('#prefs-open'); await page.waitForTimeout(150);
      const v = await page.evaluate(() => ({ cls: document.body.className, table: document.body.dataset.table, back: document.body.dataset.back, vol: document.getElementById('pref-volume').value, saved: localStorage.getItem('blackjack.prefs') }));
      await page.click('#prefs-close'); await page.waitForTimeout(100);
      return v;
    };
    const a1 = await look();
    await page.reload(); await page.waitForTimeout(300);
    const a2 = await look();
    ok('F8 settings apply at once', /anim-off/.test(a1.cls) && a1.vol === '30', a1);
    ok('F8 settings survive reload', a2.cls === a1.cls && a2.vol === '30' && a2.table === 'blue' && a2.back === 'red', { a1, a2 });
    // speed off: a deal settles with no animation delay
    await page.fill('#bet', '10'); await page.check('input[name="spots"][value="1"]');
    const t0 = Date.now(); await page.click('#deal');
    for (let i = 0; i < 50 && !(await en('#hit')) && !(await en('#deal')) && !(await en('#no-insure')); i++) await page.waitForTimeout(20);
    ok('F8 animation off: actions ready almost instantly', Date.now() - t0 < 400, { ms: Date.now() - t0 });

    // reduced motion default
    const rm = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await rm.goto(url); await rm.evaluate(() => localStorage.clear()); await rm.reload();
    ok('F8 Automatic respects prefers-reduced-motion', /anim-off/.test(await rm.evaluate(() => document.body.className)), await rm.evaluate(() => document.body.className));
    await rm.close();

    // ---- phone: 3 spots mid-hand ----
    const ph = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    await ph.goto(url); await ph.evaluate(() => localStorage.clear()); await ph.reload();
    await ph.check('input[name="spots"][value="3"]'); await ph.fill('#bet', '10'); await ph.click('#deal'); await ph.waitForTimeout(800);
    if (await ph.$eval('#no-insure', (e) => !e.disabled && !e.closest('[hidden]')).catch(() => false)) { await ph.click('#no-insure'); await ph.waitForTimeout(500); }
    const lay = await ph.evaluate(() => ({ hitBottom: document.getElementById('hit').getBoundingClientRect().bottom, vw: document.documentElement.scrollWidth, handsTop: document.getElementById('player-hands').getBoundingClientRect().top }));
    await ph.screenshot({ path: path.join(out, 'phone-3-spots.png') });
    ok('Phone 390x844: 3-spot hand fits (Hit on screen, no overflow)', lay.hitBottom <= 844 && lay.vw <= 390, lay);
    await ph.close();
  } catch (e) { r.errors.push('HARNESS ' + e.message.split('\n').slice(0,4).join(' / ') + ' @ ' + (e.stack.split('\n').find((l) => l.includes('f5_f8_f9')) || '')); }
  await browser.close(); srv.close();
  console.log(JSON.stringify(r, null, 1));
});
