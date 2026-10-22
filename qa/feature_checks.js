#!/usr/bin/env node
/**
 * Feature checks that ui_playtest.js doesn't cover: hint, coach notes,
 * accuracy stats, shortcuts help dialog, stranded-bankroll handling. Each
 * check skips itself when its element is missing, so the script keeps
 * running across versions. Usage: node feature_checks.js <snapshotDir> <outDir>
 */
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('./lib/browser');
const dir = path.resolve(process.argv[2]);
const out = path.resolve(process.argv[3]);
fs.mkdirSync(out, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const serve = () => new Promise((r) => {
  const srv = http.createServer((req, res) => {
    const p = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    const f = p.endsWith('/') ? path.join(p, 'index.html') : p;
    if (!f.startsWith(dir) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  srv.listen(0, '127.0.0.1', () => r(srv));
});

(async () => {
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}/index.html`;
  const browser = await chromium.launch({ headless: !process.env.HEADED, slowMo: process.env.HEADED ? Number(process.env.SLOWMO || 250) : 0 });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url);
  const has = async (s) => !!(await page.$(s));
  const txt = (s) => page.$eval(s, (e) => e.textContent.trim()).catch(() => null);
  const visible = (s) => page.$eval(s, (e) => !e.hidden && !e.closest('[hidden]') && e.offsetParent !== null).catch(() => false);
  const enabled = (s) => page.$eval(s, (e) => !e.disabled && !e.closest('[hidden]')).catch(() => false);
  const r = { checks: {}, errors };
  const ok = (name, pass, detail) => { r.checks[name] = { pass, ...(detail ? { detail } : {}) }; };

  // Deal until a normal decision (no insurance offer, round live).
  async function dealToDecision(bet = '10') {
    for (let i = 0; i < 30; i++) {
      await page.fill('#bet', bet);
      await page.click('#deal');
      if (await enabled('#no-insure')) await page.click('#no-insure');
      if (await enabled('#hit')) return true;
    }
    return false;
  }

  if (await has('#hint')) {
    await dealToDecision();
    await page.click('#hint');
    const hint = await txt('#hint-text');
    const suggested = await page.$$eval('.suggested', (els) => els.map((e) => e.id));
    ok('hint shows advice and highlights one button', !!hint && suggested.length === 1, { hint, suggested });
    await page.screenshot({ path: path.join(out, 'f1-hint.png') });
    // Deliberately play off-chart: pick an enabled action that is not suggested.
    const opts = [];
    for (const id of ['hit', 'stand', 'double', 'surrender']) if (id !== suggested[0] && (await enabled('#' + id))) opts.push(id);
    const accBefore = await txt('#stat-accuracy');
    await page.click('#' + opts[0]);
    const coach = (await visible('#coach')) ? await txt('#coach') : null;
    ok('off-chart move produces a coach note', !!coach && /basic strategy/i.test(coach), { chose: opts[0], coach });
    ok('accuracy stat updates after a scored move', (await txt('#stat-accuracy')) !== accBefore, { before: accBefore, after: await txt('#stat-accuracy') });
    ok('hint clears after acting', !(await visible('#hint-text')));
    await page.screenshot({ path: path.join(out, 'f2-coach-note.png') });
    while (await enabled('#stand')) await page.click('#stand');
  }

  if (await has('#coach-toggle')) {
    await page.keyboard.press('c');
    const off = await page.$eval('#coach-toggle', (e) => e.getAttribute('aria-pressed'));
    await page.keyboard.press('c');
    const on = await page.$eval('#coach-toggle', (e) => e.getAttribute('aria-pressed'));
    ok('C toggles coach notes', off === 'false' && on === 'true', { off, on });
  }

  if (await has('#help')) {
    await page.keyboard.press('Shift+Slash');
    const open1 = await page.$eval('#help', (e) => e.open);
    const items = await page.$$eval('#help-list kbd', (els) => els.map((e) => e.textContent));
    await page.screenshot({ path: path.join(out, 'f3-help.png') });
    await page.keyboard.press('h'); // must not act behind the modal
    await page.keyboard.press('Escape');
    const open2 = await page.$eval('#help', (e) => e.open);
    ok('? opens help, Esc closes it', open1 && !open2, { keys: items });
    // Does every button with a <kbd> hint appear in the help list?
    const btnKeys = await page.$$eval('button kbd', (els) => els.map((e) => e.textContent.trim().toUpperCase()));
    const missing = btnKeys.filter((k) => !items.map((x) => x.toUpperCase()).includes(k));
    ok('help lists every on-screen shortcut', missing.length === 0, { missing });
  }

  // Stranded bankroll: play $1 hands and surrender whenever possible until < $1.
  let strandedAt = null;
  for (let i = 0; i < 400; i++) {
    const b = Number(((await txt('#bankroll')) || '').replace(/[^0-9.]/g, ''));
    if (b < 1) { strandedAt = b; break; }
    await page.fill('#bet', String(b >= 2 ? Math.floor(b - 1) : 1));
    if (b < 2) await page.fill('#bet', '1');
    await page.click('#deal');
    if (await enabled('#no-insure')) await page.click('#no-insure');
    if (await enabled('#surrender')) await page.click('#surrender');
    while (await enabled('#stand')) await page.click('#stand');
  }
  if (strandedAt !== null && strandedAt > 0) {
    const reset = await visible('#reset');
    const dealEnabled = await enabled('#deal');
    if (dealEnabled) { await page.fill('#bet', '1'); await page.click('#deal'); }
    const dealt = await enabled('#hit');
    ok('bankroll below min bet offers a reset', reset, { bankroll: strandedAt, resetVisible: reset, dealEnabled, couldDeal: dealt, message: await txt('#message') });
    await page.screenshot({ path: path.join(out, 'f4-stranded.png') });
  } else ok('bankroll below min bet offers a reset', null, { note: 'did not reach a fractional sub-$1 bankroll', strandedAt });

  await browser.close();
  srv.close();
  console.log(JSON.stringify(r, null, 1));
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
