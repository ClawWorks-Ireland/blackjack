// B109: Enter in the shoe report's first 500 ms (the report opened by itself,
// over the controls the player was aiming at) still deals one round; after
// that, or on a report opened by hand, Enter behaves as before.
// Single-deck table so the cut card comes quickly. Stands on everything.
// Usage: node qa/b109_report_key_check.js <url>
const { chromium } = require('./lib/browser');
const { reachReport } = require('./lib/reach');
const { runGraceCheck } = require('./lib/grace');
const { AC6_SEED, ac6Verdict } = require('./lib/ac6');

const URL_ = process.argv[2];
const checks = {};
const put = (k, pass, detail) => { checks[k] = { pass, detail }; };
const errors = [];

const enabled = (p, s) => p.$eval(s, (e) => !e.disabled && !e.hidden && e.offsetParent !== null).catch(() => false);
const reportOpen = (p) => p.$eval('#report', (d) => d.open).catch(() => false);
const inHand = (p) => p.evaluate(() => document.body.classList.contains('in-hand'));
const rounds = (p) => p.$eval('#stat-rounds', (e) => Number(e.textContent.replace(/[^\d]/g, '')));
const reportText = (p) => p.evaluate(() => ({ title: document.getElementById('report-title').textContent, sub: document.getElementById('report-sub').textContent }));
const bankroll = (p) => p.$eval('#bankroll', (e) => Number(e.textContent.replace(/[^\d]/g, '')));
const active = (p) => p.evaluate(() => document.activeElement && document.activeElement.id);

// Harness recorder, installed before the page's own scripts. window.__b109 holds
// when #report last opened (openedAt) and the first keydown since (keyAt), both
// on the page's own clock, so pressMs does not include any Playwright latency.
function installRecorder() {
  const rec = { openedAt: null, keyAt: null };
  window.__b109 = rec;
  window.addEventListener('keydown', (e) => {
    if (rec.openedAt !== null && rec.keyAt === null) rec.keyAt = e.timeStamp;
  }, true);
  document.addEventListener('DOMContentLoaded', () => {
    const dlg = document.getElementById('report');
    if (!dlg) return;
    const opened = () => { rec.openedAt = performance.now(); rec.keyAt = null; };
    if (dlg.open) opened();
    let was = dlg.open;
    new MutationObserver(() => {
      if (dlg.open && !was) opened();
      was = dlg.open;
    }).observe(dlg, { attributes: true, attributeFilter: ['open'] });
  });
}

async function freshPage(b) {
  const p = await b.newPage();
  p.on('pageerror', (e) => errors.push(e.stack || String(e)));
  await p.addInitScript(installRecorder);
  await p.goto(URL_);
  await p.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('blackjack.prefs', JSON.stringify({ speed: 'off' }));
    localStorage.setItem('blackjack.rules', JSON.stringify({ decks: 1 }));
  });
  await p.reload();
  await p.waitForSelector('#deal');
  return p;
}

async function playOut(p) {
  for (let s = 0; s < 40 && (await inHand(p)); s++) {
    const target = (await enabled(p, '#no-insure')) ? '#no-insure' : '#stand';
    if (await enabled(p, target)) await p.click(target);
    else await p.waitForTimeout(20);
  }
}

const visible = (p, s) => p.$eval(s, (e) => !e.hidden && e.offsetParent !== null).catch(() => false);

let browser;

// Page operations for qa/lib/reach.js (the logic is unit-tested there).
const ops = {
  freshTable: () => freshPage(browser),
  closeTable: (p) => p.close(),
  reportOpen,
  canDeal: async (p) => (await enabled(p, '#deal')) && !(await inHand(p)),
  isBroke: async (p) => (await visible(p, '#reset')) ||
    (!(await enabled(p, '#deal')) && !(await inHand(p)) && !(await reportOpen(p))),
  bankroll,
  deal: async (p, bet) => { await p.fill('#bet', String(bet)); await p.click('#deal'); },
  playOut,
  waitReport: (p, ms) => p.waitForFunction(() => document.getElementById('report').open, null, { polling: 'raf', timeout: ms }).then(() => true, () => false),
};

const reachFailure = (r) => {
  const detail = { reason: r.reason, tables: r.tables, rounds: r.rounds, bankroll: r.bankroll, broke: r.broke };
  if (r.reason === 'no-report') detail.note = 'game defect: shoe passed the cut card without a report';
  return detail;
};

/** Reach a shoe report, or fail every named check with the diagnosis and return null. */
async function reach(names, opts) {
  const r = await reachReport(ops, opts);
  if (r.ok) return r;
  const detail = reachFailure(r);
  for (const n of names) put(n, false, detail);
  return null;
}

// One round trip just before the key press: everything slow comes after it.
const snapshot = (p) => p.evaluate(() => {
  const num = (id) => Number(document.getElementById(id).textContent.replace(/[^\d]/g, ''));
  return {
    open: document.getElementById('report').open,
    rounds: num('stat-rounds'),
    title: document.getElementById('report-title').textContent,
    sub: document.getElementById('report-sub').textContent,
    focus: document.activeElement && document.activeElement.id,
    bank: num('bankroll'),
  };
});

/** The page's own timing of the press: { pressMs, openedAt, keyAt } (pressMs null if either is missing). */
const pressRecord = (p) => p.evaluate(() => {
  const { openedAt, keyAt } = window.__b109 || {};
  const ok = typeof openedAt === 'number' && typeof keyAt === 'number';
  return { pressMs: ok ? keyAt - openedAt : null, openedAt: openedAt ?? null, keyAt: keyAt ?? null };
});

/**
 * Reach a report, press a key, and judge it with runGraceCheck (late presses are
 * retried on a fresh table). press(page, snap) -> { extraOk, detail }.
 * The page of the final attempt is returned open, with its snapshot.
 */
async function graceCheck(press, o = ops) {
  let page = null;
  let snap = null;
  const res = await runGraceCheck(async () => {
    if (page) { await page.close().catch(() => {}); page = null; }
    const r = await reachReport(o);
    if (!r.ok) return { ok: false, detail: { ...reachFailure(r), reachReason: r.reason } };
    page = r.table;
    snap = await snapshot(page);
    const { extraOk, detail } = await press(page, snap);
    const { pressMs } = await pressRecord(page);
    await playOut(page);
    const dealt = (await rounds(page)) - snap.rounds;
    return { open: snap.open, pressMs, dealt, extraOk, detail: { ...detail, dealt, tables: r.tables } };
  });
  return { res, page, snap };
}

const record = (name, res) => put(name, res.pass, {
  ...res.detail, pressMs: res.pressMs, outcome: res.outcome, attempts: res.attempts, history: res.history, reason: res.reason,
});

(async () => {
  const b = await chromium.launch({ headless: true });
  browser = b;
  try {
    // AC1 + AC2: Enter pressed just as the report opens.
    {
      const { res, page: p, snap } = await graceCheck(async (pg, s) => {
        await pg.keyboard.press('Enter');
        await pg.waitForTimeout(100);
        const closed = !(await reportOpen(pg));
        return { extraOk: closed, detail: { focus: s.focus, closed } };
      });
      record('AC1 Enter in grace window deals one round', res);
      if (res.reason === 'no-report') {
        put('AC2 held report reopens for the same shoe between rounds', false, res.detail);
      } else {
      const first = { title: snap.title, sub: snap.sub };
      const r = { tables: res.detail.tables };
      let reopened = false;
      try { await p.waitForFunction(() => document.getElementById('report').open, null, { polling: 'raf', timeout: 1500 }); reopened = true; } catch (e) { /* stays closed */ }
      const again = reopened ? await reportText(p) : null;
      const between = !(await inHand(p));
      put('AC2 held report reopens for the same shoe between rounds',
        reopened && between && again.title === first.title && again.sub === first.sub, { reopened, between, first, again, tables: r.tables });
      await p.close();
      }
    }
    // AC3: x in the grace window deals one round at twice the last bet.
    {
      const { res, page: p } = await graceCheck(async (pg, s) => {
        await pg.keyboard.press('x');
        await pg.waitForTimeout(100);
        const closed = !(await reportOpen(pg));
        const bet = await pg.$eval('#bet', (e) => e.value);
        const guess = await pg.$eval('#rep-guess', (e) => e.value);
        return { extraOk: closed && bet === '20' && !/x/i.test(guess), detail: { closed, bet, guess, bank: s.bank } };
      });
      record('AC3 x in grace window deals one round at twice the last bet', res);
      if (p) await p.close();
    }
    // AC4: x with Rebet x2 disabled keeps the report open and deals nothing.
    {
      const r = await reach(['AC4 x with Rebet x2 disabled keeps the report open and deals nothing'], { betFor: (bank) => Math.min(255, bank), minBankroll: 251 });
      if (r) {
      const p = r.table;
      const rebet2Disabled = await p.$eval('#rebet-2', (e) => e.disabled);
      const before = await rounds(p);
      await p.keyboard.press('x');
      await p.waitForTimeout(150);
      const open = await reportOpen(p);
      const dealt = (await rounds(p)) - before;
      put('AC4 x with Rebet x2 disabled keeps the report open and deals nothing',
        rebet2Disabled && open && dealt === 0, { rebet2Disabled, open, dealt, tables: r.tables });
      await p.close();
      }
    }
    // AC5: after the grace window Enter deals nothing.
    {
      const r = await reach(['AC5 Enter after grace window deals nothing']);
      if (r) {
      const p = r.table;
      const before = await rounds(p);
      await p.waitForTimeout(1000);
      const focus = await active(p);
      await p.keyboard.press('Enter');
      await p.waitForTimeout(150);
      const dealt = (await rounds(p)) - before;
      const closed = !(await reportOpen(p));
      const guessError = await p.evaluate(() => { const e = document.getElementById('rep-count-result'); return e ? e.textContent.trim() : ''; });
      put('AC5 Enter after grace window deals nothing', dealt === 0, { focus, closed, guessError, dealt, tables: r.tables });
      await p.close();
      }
    }
    // AC6: the session report (opened by hand) has no grace window.
    // Enter on the focused Close button closes the report (standard dialog
    // behaviour, #189 Q1 a), so x goes first while the report is open. A round
    // counts as dealt once in-hand is set or the bankroll moves, not only when
    // it finishes (#stat-rounds counts finished rounds).
    // The verdict is ac6Verdict (unit-tested in qa/lib/ac6.test.js) and rests on
    // the random run alone. The seeded run and the repro (AC6_SEED, where round 2
    // ends at the deal) are evidence for #189 AC-2 and AC-4 and go in the detail.
    {
      const ac6Run = async (p) => {
        await p.fill('#bet', '10');
        await p.click('#deal');
        await playOut(p);
        await p.waitForTimeout(100);
        const before = await rounds(p);
        const bank0 = await bankroll(p);
        const rebet2Usable = await enabled(p, '#rebet-2');
        const dealUsable = await enabled(p, '#deal');
        await p.click('#report-open');
        const opened = await reportOpen(p);
        const focusOnOpen = await active(p);
        await p.keyboard.press('x');
        await p.waitForTimeout(150);
        const openAfterX = await reportOpen(p);
        const inHandAfterX = await inHand(p);
        const bankAfterX = await bankroll(p);
        let focusBeforeEnter = null;
        let inHandAfterEnter = null;
        let bankAfterEnter = null;
        let openAfterEnter = null;
        if (openAfterX) {
          focusBeforeEnter = await active(p);
          await p.keyboard.press('Enter');
          await p.waitForTimeout(150);
          inHandAfterEnter = await inHand(p);
          bankAfterEnter = await bankroll(p);
          openAfterEnter = await reportOpen(p);
        }
        await playOut(p);
        const dealt = (await rounds(p)) - before;
        return {
          rebet2Usable, dealUsable, opened, focusOnOpen, openAfterX, inHandAfterX,
          focusBeforeEnter, inHandAfterEnter, openAfterEnter,
          bankBefore: bank0, bankAfterX, bankAfterEnter, dealt,
        };
      };

      // A table on a typed seed. freshPage's reload would restore the game it saved
      // under blackjack.game (web/app.js loadGame), so storage is cleared and the
      // seed set in one evaluate before the reload.
      const seededPage = async (br, seed) => {
        const p = await br.newPage();
        p.on('pageerror', (e) => errors.push(e.stack || String(e)));
        await p.addInitScript(installRecorder);
        await p.goto(URL_);
        await p.evaluate((s) => {
          localStorage.clear();
          localStorage.setItem('blackjack.prefs', JSON.stringify({ speed: 'off' }));
          localStorage.setItem('blackjack.rules', JSON.stringify({ decks: 1 }));
          localStorage.setItem('blackjack.seed', s);
        }, seed);
        await p.reload();
        await p.waitForSelector('#deal');
        const seedInPlay = await p.evaluate(() => {
          try {
            const g = JSON.parse(localStorage.getItem('blackjack.game'));
            return { seed: g.seed, shoeNo: g.shoeNo };
          } catch (e) { return null; }
        });
        return { p, seedInPlay };
      };

      const p = await freshPage(b);
      const randomDetail = await ac6Run(p);
      await p.close();

      let seeded;
      let sp = null;
      try {
        const made = await seededPage(b, AC6_SEED);
        sp = made.p;
        const seededDetail = await ac6Run(sp);
        // Old-sequence repro: the report is closed now, so x deals Rebet x2. On
        // AC6_SEED that round ends at the deal and #stat-rounds goes up within 150 ms.
        let reproStarted = null;
        let reproRoundsDelta = null;
        if (seededDetail.openAfterEnter === false) {
          const bankNow = await bankroll(sp);
          const roundsNow = await rounds(sp);
          await sp.keyboard.press('x');
          await sp.waitForTimeout(150);
          reproRoundsDelta = (await rounds(sp)) - roundsNow;
          reproStarted = (await inHand(sp)) || (await bankroll(sp)) !== bankNow;
        }
        seeded = {
          seed: AC6_SEED, seedInPlay: made.seedInPlay, ...seededDetail,
          verdict: ac6Verdict(seededDetail), reproStarted, reproRoundsDelta,
        };
      } catch (e) {
        seeded = { error: String(e) };
      }
      if (sp) await sp.close().catch(() => {});

      put('AC6 session report has no grace window', ac6Verdict(randomDetail), { ...randomDetail, seeded });
    }
    // AC7: a held Enter (auto-repeat) deals exactly one round.
    {
      // The CDP session is opened with the page, before the report is reached, so it
      // adds nothing to pressMs.
      const cdps = new WeakMap();
      const opsCdp = {
        ...ops,
        freshTable: async () => {
          const pg = await freshPage(browser);
          cdps.set(pg, await pg.context().newCDPSession(pg));
          return pg;
        },
      };
      const { res, page: p } = await graceCheck(async (pg) => {
        const cdp = cdps.get(pg);
        const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' };
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, autoRepeat: true });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, autoRepeat: true });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
        return { extraOk: true, detail: {} };
      }, opsCdp);
      record('AC7 held Enter deals exactly one round', res);
      if (p) await p.close();
    }
  } catch (e) {
    errors.push('HARNESS ' + (e.stack || e.message).split('\n').slice(0, 3).join(' | '));
  }
  await b.close();
  const failed = Object.entries(checks).filter(([, v]) => !v.pass).map(([k]) => k);
  console.log(JSON.stringify({ failed, checks, errors }, null, 1));
  process.exit(failed.length || errors.length ? 1 : 0);
})();
