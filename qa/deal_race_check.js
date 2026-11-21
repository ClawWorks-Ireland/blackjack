#!/usr/bin/env node
/**
 * Deterministic repro of the lost Deal click (#96). The F18 shoe report is a
 * modal <dialog id="report">; a click that lands on its backdrop closes it
 * (web/app.js, backdrop handler) and never reaches #deal. Playwright checks the
 * hit target before it presses, so the report has to open *between* that check
 * and the press. A page hook opens it then; we try several hook points and
 * record which one makes the pre-#96 helper lose the round.
 *
 * Three cases, each in a fresh context:
 *   1 legacy  - pre-#96 clickDeal loses the round: 'stats Rounds did not increment by 1'
 *   2 fixed   - dealRound (qa/lib/deal.js), hook fires once: round dealt, Rounds +1
 *   3 stuck   - hook fires on every attempt: exactly one 'Deal did not start a round'
 * `findings` lists only unmet expectations, so run-round.js passes on an empty list.
 * Usage: node deal_race_check.js <snapshotDir> <outDir>
 */
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const { pagePath } = require('./lib/layout');
const { dealRound, crossCheck } = require('./lib/deal');
const { chromium } = require('./lib/browser');

const dir = path.resolve(process.argv[2]);
const out = path.resolve(process.argv[3]);
fs.mkdirSync(out, { recursive: true });

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

const SEL = { bet: '#bet', deal: '#deal', hit: '#hit', stand: '#stand', noInsure: '#no-insure', bankroll: '#bankroll', message: '#message', hands: '#player-hands .player-hand', statNet: '#stat-net', statRounds: '#stat-rounds', statRecord: '#stat-record' };

// Hook points tried in order for the legacy case. Each opens #report the moment it fires.
const HOOKS = ['mousemove', 'pointermove', 'pointerdown', 'mousedown', 'close-wrap'];

/** Page script: arm window.__race = { hook, fires } and open the report that many times. */
function installHook() {
  window.__race = { hook: null, fires: 0, opened: 0 };
  const open = () => {
    const r = window.__race;
    const d = document.getElementById('report');
    if (!r.hook || r.fires <= 0 || !d || d.open) return;
    r.fires--; r.opened++;
    d.showModal();
  };
  for (const t of ['mousemove', 'pointermove', 'pointerdown', 'mousedown']) {
    document.addEventListener(t, (e) => {
      if (window.__race.hook === t && e.target && e.target.closest && e.target.closest('#deal')) open();
    }, true);
  }
  const proto = window.HTMLDialogElement && window.HTMLDialogElement.prototype;
  if (proto && proto.close) {
    const orig = proto.close;
    proto.close = function (...a) {
      const res = orig.apply(this, a);
      if (this.id === 'report' && window.__race.hook === 'close-wrap') setTimeout(open, 0);
      return res;
    };
  }
}

const money = (s) => {
  if (!s) return NaN;
  const m = String(s).replace(/[,\s]/g, '').match(/(-|−)?\+?\$(-)?([\d.]+)/);
  if (!m) return NaN;
  return (m[1] || m[2] ? -1 : 1) * Number(m[3]);
};

async function newCase(browser, url) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.addInitScript(installHook);
  await page.goto(url);
  await page.waitForSelector(SEL.deal);
  const text = (s) => page.$eval(s, (e) => e.textContent.trim()).catch(() => null);
  const enabled = (s) => page.$eval(s, (e) => !e.disabled && !e.closest('[hidden]') && e.offsetParent !== null).catch(() => false);
  const record = async () => {
    const n = ((await text(SEL.statRecord)) || '').split(/[–-]/).map(Number);
    return n.length === 3 ? n[0] + n[1] + n[2] : NaN;
  };
  return { ctx, page, text, enabled, record };
}

// Pre-#96 clickDeal, verbatim (labelled legacy): closes the report, clicks, and trusts the click.
async function clickDealLegacy(page, sel) {
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

/** One playtest iteration. mode: 'legacy' | 'guarded'. Returns { findings, started, race }. */
async function iteration(c, mode, hook, fires) {
  const { page, text, enabled, record } = c;
  const bank0 = money(await text(SEL.bankroll));
  const net0 = money(await text(SEL.statNet));
  const rounds0 = Number(await text(SEL.statRounds));
  const rec0 = await record();
  await page.fill(SEL.bet, '10');
  await page.evaluate(([h, n]) => { window.__race.hook = h; window.__race.fires = n; window.__race.opened = 0; }, [hook, fires]);
  const findings = [];
  let reportOpened = false;
  let started = true;
  if (mode === 'legacy') {
    await clickDealLegacy(page, SEL.deal);
  } else {
    const dealt = await dealRound(page, {
      probe: async () => ({
        inHand: await page.evaluate(() => document.body.classList.contains('in-hand')),
        hitEnabled: await enabled(SEL.hit),
        noInsureEnabled: await enabled(SEL.noInsure),
        rounds: Number(await text(SEL.statRounds)),
      }),
      closeReport: () => page.evaluate(() => { const d = document.getElementById('report'); if (d && d.open) d.close(); }),
      clickDeal: () => page.click(SEL.deal, { timeout: 2000 }).catch(() => {}),
      reportOpen: () => page.$eval('#report', (d) => d.open).catch(() => false),
    });
    reportOpened = dealt.reportOpened;
    started = dealt.started;
    if (!started) {
      findings.push({ issue: 'Deal did not start a round', detail: { round: 1, attempts: dealt.attempts, bank0, bank1: money(await text(SEL.bankroll)), msg: await text(SEL.message), reportOpened } });
    }
  }
  const race = await page.evaluate(() => ({ ...window.__race }));
  reportOpened = reportOpened || race.opened > 0;
  if (started) {
    await page.evaluate(() => { const d = document.getElementById('report'); if (d && d.open) d.close(); });
    for (let s = 0; s < 40; s++) {
      if (await enabled(SEL.noInsure)) { await page.click(SEL.noInsure); continue; }
      if (await enabled(SEL.stand)) { await page.click(SEL.stand); continue; }
      break;
    }
    const after = {
      bank1: money(await text(SEL.bankroll)), net1: money(await text(SEL.statNet)),
      rounds1: Number(await text(SEL.statRounds)), rec1: await record(),
      handsN: await page.$$eval(SEL.hands, (els) => els.length).catch(() => 0),
    };
    findings.push(...crossCheck({ round: 1, before: { bank0, net0, rounds0, rec0 }, after, msg: await text(SEL.message), reportOpened }));
    return { findings, started, race, rounds: { rounds0, rounds1: after.rounds1 } };
  }
  return { findings, started, race };
}

const issues = (r) => r.findings.map((f) => f.issue);
const STATS = /^(stats Rounds|W-L-P|stats Net)/;

async function main() {
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}${pagePath(dir)}`;
  const browser = await chromium.launch({ headless: !process.env.HEADED });
  const problems = [];
  const cases = {};
  try {
    // Case 1: find a hook that makes the legacy helper lose the round.
    const tried = {};
    let hook = null;
    for (const h of HOOKS) {
      const c = await newCase(browser, url);
      const r = await iteration(c, 'legacy', h, 1);
      await c.ctx.close();
      tried[h] = { opened: r.race.opened, issues: issues(r) };
      if (!hook && issues(r).includes('stats Rounds did not increment by 1')) { hook = h; cases.legacy = { hook: h, findings: r.findings }; }
    }
    const legacyReproduced = hook !== null;
    cases.legacy = { legacyReproduced, hook, tried, ...(cases.legacy || {}) };
    if (!legacyReproduced) problems.push('legacy helper did not lose the round with any hook (race theory not confirmed): see cases.legacy.tried');
    const useHook = hook || HOOKS[0];

    // Case 2: new helper, hook fires once -> dealt, Rounds +1.
    {
      const c = await newCase(browser, url);
      const r = await iteration(c, 'guarded', useHook, 1);
      await c.ctx.close();
      cases.fixed = { hook: useHook, started: r.started, opened: r.race.opened, rounds: r.rounds, issues: issues(r) };
      if (!r.started || r.findings.length || !r.rounds || r.rounds.rounds1 !== r.rounds.rounds0 + 1) problems.push('new helper did not deal exactly one round: see cases.fixed');
    }
    // Case 3: hook reopens the report on every attempt -> one no-deal finding, no stats findings.
    {
      const c = await newCase(browser, url);
      const r = await iteration(c, 'guarded', useHook, 1000);
      await c.ctx.close();
      cases.cannotDeal = { hook: useHook, started: r.started, opened: r.race.opened, issues: issues(r) };
      const noDeal = issues(r).filter((i) => i === 'Deal did not start a round').length;
      if (noDeal !== 1 || issues(r).some((i) => STATS.test(i))) problems.push('cannot-deal case: expected exactly one "Deal did not start a round" and no stats findings: see cases.cannotDeal');
    }
  } finally {
    await browser.close();
    srv.close();
  }
  console.log(JSON.stringify({
    legacyReproduced: Boolean(cases.legacy && cases.legacy.legacyReproduced),
    hook: cases.legacy && cases.legacy.hook,
    cases, findings: problems,
  }, null, 1));
  process.exit(problems.length ? 1 : 0);
}

main().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
