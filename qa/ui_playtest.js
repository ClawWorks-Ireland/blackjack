#!/usr/bin/env node
/**
 * UI playtest for the BlackJack-creator game: serves a snapshot dir on
 * 127.0.0.1 (ephemeral port, loopback only), drives it in headless Chromium
 * and checks what a player sees. Prints a compact JSON report and writes
 * screenshots. Usage: node ui_playtest.js <snapshotDir> <outDir> [rounds]
 *
 * Selectors follow the game's current ids (#bet, #deal, #hit, ...). When the
 * game changes its markup, update SEL below rather than the checks.
 */
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const { pagePath } = require('./lib/layout');

const { chromium } = require('./lib/browser');

const dir = path.resolve(process.argv[2]);
const out = path.resolve(process.argv[3]);
const ROUNDS = Number(process.argv[4] || 80);
fs.mkdirSync(out, { recursive: true });

const SEL = {
  bet: '#bet', deal: '#deal', hit: '#hit', stand: '#stand', double: '#double', split: '#split',
  surrender: '#surrender', insurance: '#insurance', insure: '#insure', noInsure: '#no-insure',
  reset: '#reset', bankroll: '#bankroll', message: '#message', hands: '#player-hands .player-hand',
  statNet: '#stat-net', statRounds: '#stat-rounds', statRecord: '#stat-record', history: '#history li',
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };
function serve() {
  const srv = http.createServer((req, res) => {
    const p = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    const file = p.endsWith('/') ? path.join(p, 'index.html') : p;
    if (!file.startsWith(dir) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

const money = (s) => {
  if (!s) return NaN;
  const m = String(s).replace(/[,\s]/g, '').match(/(-|−)?\+?\$(-)?([\d.]+)/);
  if (!m) return NaN;
  return (m[1] || m[2] ? -1 : 1) * Number(m[3]);
};
const findings = [];
const seen = new Set();
/**
 * Click Deal. The F18 shoe report opens on a timer after the cut-card round,
 * so it can appear between our last look and the click (T5): close it and
 * retry rather than wait out Playwright's 30 s timeout.
 */
async function clickDeal(page, sel) {
  for (let attempt = 0; ; attempt++) {
    await page.evaluate(() => { const d = document.getElementById('report'); if (d && d.open) d.close(); });
    try {
      await page.click(sel, { timeout: 2000 });
      return;
    } catch (e) {
      if (attempt >= 3) throw e;
    }
  }
}

function flag(issue, detail) {
  if (seen.has(issue)) { findings.find((f) => f.issue === issue).count++; return; }
  seen.add(issue);
  findings.push({ issue, count: 1, detail });
}

async function main() {
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}${pagePath(dir)}`;
  const browser = await chromium.launch({ headless: !process.env.HEADED, slowMo: process.env.HEADED ? Number(process.env.SLOWMO || 250) : 0 });
  const shots = [];
  const shot = async (page, name) => {
    const f = path.join(out, `${name}.png`);
    await page.screenshot({ path: f, fullPage: true });
    shots.push(f);
  };
  const consoleErrors = [];
  const hook = (page) => {
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  };

  // ---------------- desktop, reduced motion: random play ----------------
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  hook(page);
  await page.goto(url);
  await page.waitForSelector(SEL.deal);
  await shot(page, '01-initial');

  const text = (s) => page.$eval(s, (e) => e.textContent.trim()).catch(() => null);
  const enabled = (s) => page.$eval(s, (e) => !e.disabled && !e.closest('[hidden]') && e.offsetParent !== null).catch(() => false);
  const count = (s) => page.$$eval(s, (els) => els.length).catch(() => 0);
  const record = async () => {
    const t = await text(SEL.statRecord);
    const n = (t || '').split(/[–-]/).map(Number);
    return n.length === 3 ? n[0] + n[1] + n[2] : NaN;
  };

  const tally = { rounds: 0, splits: 0, doubles: 0, surrenders: 0, insurance: 0, blackjacks: 0, maxHands: 1 };
  const firsts = {};
  const bankrollTexts = new Set();
  const bets = [5, 10, 25, 50, 15, 3, 100, 7];
  for (let i = 0; i < ROUNDS; i++) {
    const bank0 = money(await text(SEL.bankroll));
    if (!(bank0 >= 1)) {
      if (bank0 > 0 && !(await enabled(SEL.reset))) flag('stranded below the $1 minimum bet with no reset offered', { bankroll: await text(SEL.bankroll) });
      break;
    }
    const net0 = money(await text(SEL.statNet));
    const rounds0 = Number(await text(SEL.statRounds));
    const rec0 = await record();
    const bet = Math.min(bets[i % bets.length], Math.floor(bank0));
    await page.fill(SEL.bet, String(bet));
    await clickDeal(page, SEL.deal);
    let steps = 0;
    let usedKey = false;
    while (steps++ < 40) {
      // B16: the delayed F18 shoe report can open after the next deal and block the hand.
      if (await page.$eval('#report', (d) => d.open).catch(() => false)) {
        flag('shoe report opened during a hand (B16)', { round: i + 1, step: steps });
        if (!firsts.reportMidHand) { firsts.reportMidHand = true; await shot(page, 'b16-report-mid-hand'); }
        await page.evaluate(() => document.getElementById('report').close());
      }
      if (await enabled(SEL.noInsure)) {
        if (!firsts.insurance) { firsts.insurance = true; await shot(page, '02-insurance-offer'); }
        const take = i % 3 === 0 && (await enabled(SEL.insure));
        if (take) tally.insurance++;
        await page.click(take ? SEL.insure : SEL.noInsure);
        continue;
      }
      const opts = [];
      for (const k of ['hit', 'stand', 'double', 'split', 'surrender']) if (await enabled(SEL[k])) opts.push(k);
      if (!opts.length) break;
      let pick = opts.includes('split') && i % 2 === 0 ? 'split'
        : opts.includes('double') && i % 5 === 1 ? 'double'
        : opts.includes('surrender') && i % 11 === 3 ? 'surrender'
        : opts[(i + steps) % Math.min(opts.length, 2)];
      if (pick === 'split') tally.splits++;
      if (pick === 'double') tally.doubles++;
      if (pick === 'surrender') tally.surrenders++;
      if (!usedKey && pick === 'stand' && i % 4 === 0) {
        usedKey = true;
        await page.keyboard.press('s'); // shortcut path
      } else await page.click(SEL[pick]);
      const hands = await count(SEL.hands);
      tally.maxHands = Math.max(tally.maxHands, hands);
      if (hands >= 3 && !firsts.multi) { firsts.multi = true; await shot(page, '03-three-plus-hands'); }
    }
    // ---- round finished: cross-check what the player sees ----
    tally.rounds++;
    const bank1 = money(await text(SEL.bankroll));
    const bankTxt = await text(SEL.bankroll);
    bankrollTexts.add(bankTxt);
    const net1 = money(await text(SEL.statNet));
    const rounds1 = Number(await text(SEL.statRounds));
    const rec1 = await record();
    const handsN = await count(SEL.hands);
    const msg = await text(SEL.message);
    const delta = bank1 - bank0;
    if (/blackjack/i.test(msg || '')) { tally.blackjacks++; if (!firsts.bj) { firsts.bj = true; await shot(page, '04-blackjack'); } }
    if (Math.abs(delta - (net1 - net0)) > 1e-9) flag('stats Net change != bankroll change', { round: i, delta, statsDelta: net1 - net0, msg });
    if (rounds1 !== rounds0 + 1) flag('stats Rounds did not increment by 1', { round: i, rounds0, rounds1 });
    if (rec1 - rec0 !== handsN) flag('W-L-P did not grow by number of hands', { round: i, hands: handsN, grew: rec1 - rec0 });
    const hist = await page.$eval(`${SEL.history} .net`, (e) => e.textContent.trim()).catch(() => null);
    if (hist !== null && Math.abs(money(hist) - delta) > 1e-9) flag('history net != bankroll change', { round: i, hist, delta });
    if (await enabled(SEL.hit)) flag('Hit still enabled after round ended', { round: i, msg });
    if (!(await enabled(SEL.deal)) && bank1 >= 1) flag('Deal disabled after round ended', { round: i });
    if (/\.\d(?!\d)/.test(bankTxt || '')) flag('money shown with one decimal (e.g. $1002.5)', { text: bankTxt, msg });
    if (bank1 >= 1000 && !/,/.test(bankTxt || '')) flag('no thousands separator in money', { text: bankTxt });
    if (!msg) flag('empty result message after round', { round: i });
  }
  await shot(page, '05-after-random-play');

  // ---- keyboard: typing in bet box must not trigger actions ----
  await page.evaluate(() => { const d = document.getElementById("report"); if (d && d.open) d.close(); }); // F18 shoe report auto-opens at the cut
  await page.fill(SEL.bet, '');
  await page.type(SEL.bet, 'hs');
  const msgAfterType = await text(SEL.message);

  // ---- bet validation feedback ----
  const bank = money(await text(SEL.bankroll));
  const betProbe = {};
  if (process.env.QA_DEBUG) console.error('STATE', JSON.stringify(await page.evaluate(() => ({ deal: document.getElementById('deal').disabled, hit: document.getElementById('hit').disabled, msg: document.getElementById('message').textContent.trim(), bank: document.getElementById('bankroll').textContent, bet: document.getElementById('bet').value, spots: (document.getElementById('spots') || {}).value, hands: document.querySelectorAll('#player-hands .hand').length }))));
  await page.screenshot({ path: require('path').join(out, 'dbg-before-betprobe.png') });
  // Skip when broke: Deal is correctly disabled below the minimum bet, and clicking it would hang.
  for (const v of (bank >= 1 ? ['0', '-5', '2.5', String(Math.floor(bank) + 1), ''] : [])) {
    await page.fill(SEL.bet, v);
    const before = await text(SEL.message);
    await clickDeal(page, SEL.deal);
    await page.waitForTimeout(50);
    const after = await text(SEL.message);
    const valid = await page.$eval(SEL.bet, (e) => e.validationMessage).catch(() => '');
    betProbe[v || '(empty)'] = { message: after === before ? '(unchanged)' : after, nativeValidation: valid || null, dealt: await enabled(SEL.hit) };
    if (await enabled(SEL.hit)) { await page.click(SEL.stand).catch(() => {}); }
  }

  // ---- reload: what persists? ----
  const bankBeforeReload = await text(SEL.bankroll);
  // Compare all-time stats: since F7 the default "This session" scope resets on reload by design.
  const allTime = async () => { if (await page.$('#scope-all')) await page.click('#scope-all'); };
  await allTime();
  const statsBeforeReload = await text(SEL.statNet);
  await page.reload();
  await page.waitForSelector(SEL.deal);
  await allTime();
  const persistence = {
    bankrollBefore: bankBeforeReload, bankrollAfter: await text(SEL.bankroll),
    statsNetBefore: statsBeforeReload, statsNetAfter: await text(SEL.statNet),
  };
  if (persistence.bankrollBefore !== persistence.bankrollAfter) flag('bankroll resets on reload while stats persist (stats Net no longer matches chips)', persistence);

  // ---- go broke: all-in until out of chips ----
  let brokeRounds = 0;
  while (brokeRounds++ < 60) {
    const b = money(await text(SEL.bankroll));
    if (!(b >= 1)) break;
    await page.fill(SEL.bet, String(Math.floor(b)));
    await clickDeal(page, SEL.deal);
    for (let s = 0; s < 10; s++) {
      if (await enabled(SEL.noInsure)) { await page.click(SEL.noInsure); continue; }
      if (await enabled(SEL.hit)) await page.click(SEL.hit); else break;
    }
  }
  const broke = {
    bankroll: await text(SEL.bankroll),
    resetVisible: await enabled(SEL.reset),
    dealEnabled: await enabled(SEL.deal),
  };
  await shot(page, '06-broke');
  if (money(broke.bankroll) > 0 && money(broke.bankroll) < 1 && !broke.resetVisible) flag('stranded with $0.xx: cannot bet (min 1) and no reset offered', broke);
  if (broke.resetVisible) {
    await page.click(SEL.reset);
    broke.afterReset = await text(SEL.bankroll);
  }

  // ---- mobile layout ----
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  const m = await mctx.newPage();
  hook(m);
  await m.goto(url);
  await m.waitForSelector(SEL.deal);
  await m.fill(SEL.bet, '10');
  await m.tap(SEL.deal);
  const layout = await m.evaluate(() => {
    const vw = window.innerWidth;
    const overflowX = document.documentElement.scrollWidth - vw;
    const btns = [...document.querySelectorAll('button')].filter((b) => b.offsetParent);
    const small = btns.filter((b) => b.getBoundingClientRect().height < 44).map((b) => b.id || b.textContent.trim().slice(0, 20));
    const offscreen = btns.filter((b) => { const r = b.getBoundingClientRect(); return r.right > vw + 1 || r.left < -1; }).map((b) => b.id);
    const actions = document.querySelector('#hit');
    const actionsTop = actions ? actions.getBoundingClientRect().top : null;
    return { vw, overflowX, smallTapTargets: small, offscreenButtons: offscreen, actionButtonsTopPx: actionsTop, viewportH: window.innerHeight };
  });
  await shot(m, '07-mobile-in-round');
  if (layout.overflowX > 0) flag('horizontal scroll on 390px mobile', layout);
  if (layout.smallTapTargets.length) flag('tap targets under 44px tall on mobile', layout.smallTapTargets);
  if (layout.actionButtonsTopPx > layout.viewportH) flag('action buttons below the fold on mobile during a hand', layout);

  // ---- full motion: deal animation timing ----
  const actx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const a = await actx.newPage();
  hook(a);
  await a.goto(url);
  await a.fill(SEL.bet, '10');
  await a.click(SEL.deal);
  await a.waitForTimeout(120);
  const midDeal = await a.evaluate(() => ({
    message: document.querySelector('#message').textContent.trim(),
    hitEnabled: !document.querySelector('#hit').disabled,
    runningAnimations: document.getAnimations().filter((x) => x.playState === 'running').length,
  }));
  if (midDeal.hitEnabled && midDeal.runningAnimations > 0) flag('actions enabled while deal animation still running', midDeal);
  await shot(a, '08-mid-deal-animation');
  const t0 = Date.now();
  await a.keyboard.press('s'); // act during animation
  await a.waitForTimeout(1500);
  await shot(a, '09-after-stand-animated');
  const animMsg = await a.$eval(SEL.message, (e) => e.textContent.trim()).catch(() => null);

  await browser.close();
  srv.close();

  console.log(JSON.stringify({
    url: 'served snapshot on 127.0.0.1 (ephemeral)',
    tally, consoleErrors: [...new Set(consoleErrors)].slice(0, 10),
    findings, bankrollSamples: [...bankrollTexts].slice(0, 12),
    keyboardInBetBox: msgAfterType, betProbe, persistence, broke, layout,
    animatedStandMessage: animMsg, screenshots: shots,
  }, null, 1));
}

main().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
