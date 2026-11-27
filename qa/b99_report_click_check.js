// B99: a click on Deal or Rebet in the shoe report's first 500 ms (the report
// opened by itself, over the controls the player was aiming at) still deals;
// after that, or anywhere else, a backdrop click behaves as before.
// Single-deck table so the cut card comes quickly. Stands on everything.
// Usage: node qa/b99_report_click_check.js <url>
const { chromium } = require('./lib/browser');
const { runGraceCheck, GRACE_MS } = require('./lib/grace');
const { ac2Gate } = require('./lib/b99-runs');

const URL_ = process.argv[2];
const checks = {};
const put = (k, pass, detail) => { checks[k] = { pass, detail }; };
const errors = [];

const enabled = (p, s) => p.$eval(s, (e) => !e.disabled && !e.hidden && e.offsetParent !== null).catch(() => false);
const reportOpen = (p) => p.$eval('#report', (d) => d.open).catch(() => false);
const inHand = (p) => p.evaluate(() => document.body.classList.contains('in-hand'));
const rounds = (p) => p.$eval('#stat-rounds', (e) => Number(e.textContent.replace(/[^\d]/g, '')));
const reportText = (p) => p.evaluate(() => ({ title: document.getElementById('report-title').textContent, sub: document.getElementById('report-sub').textContent }));
const center = (p, s) => p.$eval(s, (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });

async function freshPage(b, viewport) {
  const p = await b.newPage({ viewport: viewport || VIEWPORT });
  p.on('pageerror', (e) => errors.push(e.stack || String(e)));
  await p.addInitScript(() => {
    // Page-side timing: when the shoe report opened (stamped in a showModal wrapper just before
    // the native call, i.e. before the app starts its grace window), and when the press
    // (pointerdown) landed and was handled.
    window.__reportOpenedAt = null;
    // Only the first press while the report is open counts, and it is fixed at that moment,
    // so later clicks (playOut) and a reopened report cannot overwrite it.
    window.__press = null;
    const native = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function showModal(...args) {
      if (this.id === 'report' && !this.open) window.__reportOpenedAt = performance.now();
      return native.apply(this, args);
    };
    document.addEventListener('pointerdown', (e) => {
      const r = document.getElementById('report');
      if (window.__press === null && r && r.open && typeof window.__reportOpenedAt === 'number') {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const text = (id) => { const n = document.getElementById(id); return n ? n.textContent : null; };
        window.__press = {
          pressMs: e.timeStamp - window.__reportOpenedAt,
          handledMs: performance.now() - window.__reportOpenedAt,
          hit: el === r ? 'backdrop' : (el && r.contains(el) ? 'panel' : 'none'),
          point: { x: e.clientX, y: e.clientY },
          title: text('report-title'),
          sub: text('report-sub'),
        };
      }
    }, true);
  });
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

/** ms from the report opening to the press landing in the page, or null if either is missing. */
const pressTiming = (p) => p.evaluate(() => {
  const s = window.__press;
  if (!s) return { pressMs: null, pressAt: null, handledMs: null, hit: null, point: null, title: null, sub: null };
  return { pressMs: s.pressMs, pressAt: s.pressMs, handledMs: s.handledMs, hit: s.hit, point: s.point, title: s.title, sub: s.sub };
});
/**
 * Run attemptFn(freshPage) up to 3 times, each on a fresh page. It returns { p, pass, detail }
 * (plus noPress: true when it never pressed, so the verdict stands). A press that landed
 * after the grace window is inconclusive and retried; three late presses fail.
 * Returns the final attempt's page (left open) so a later check can read from it.
 */
async function graceCheck(name, b, attemptFn) {
  const late = [];
  for (let attempts = 1; attempts <= 3; attempts++) {
    const r = await attemptFn((vp) => freshPage(b, vp));
    if (r.noPress) { put(name, r.pass, { ...r.detail, pressAt: null, attempts }); return r.p; }
    const { pressAt } = await pressTiming(r.p);
    if (pressAt !== null && pressAt >= 0 && pressAt < GRACE_MS) {
      put(name, r.pass, { ...r.detail, pressAt, attempts });
      return r.p;
    }
    late.push(pressAt);
    if (attempts === 3) {
      put(name, false, { ...r.detail, precondition: 'press outside grace window', pressAt, pressAts: late, attempts });
      return r.p;
    }
    await r.p.close();
  }
}

async function playOut(p) {
  for (let s = 0; s < 40 && (await inHand(p)); s++) {
    const target = (await enabled(p, '#no-insure')) ? '#no-insure' : '#stand';
    if (await enabled(p, target)) await p.click(target);
    else await p.waitForTimeout(20);
  }
}

/** Deal and play rounds until the shoe report opens by itself between rounds. */
async function reachReport(p, pre) {
  let read;
  for (let i = 0; i < 80; i++) {
    if (await reportOpen(p)) { if (pre && read === undefined) read = await pre(p); return pre ? { read } : true; }
    if (await enabled(p, '#deal')) {
      await p.fill('#bet', '10');
      await p.click('#deal');
    }
    await playOut(p);
    // Hand over, report not open yet: read what the caller needs now, so nothing is read after it opens.
    if (pre) read = await pre(p);
    try {
      await p.waitForFunction(() => document.getElementById('report').open, null, { polling: 'raf', timeout: 1000 });
      return pre ? { read } : true;
    } catch (e) { /* no cut card yet */ }
  }
  return false;
}

const VIEWPORT = { width: 1280, height: 720 };
const rectOf = (p, s) => p.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; }, s);
/** Where a click at (x, y) lands: the dialog backdrop (#report itself), the panel, or neither. */
const hitAt = (p, x, y) => p.evaluate(([px, py]) => {
  const el = document.elementFromPoint(px, py);
  const rep = document.getElementById('report');
  return el === rep ? 'backdrop' : (el && rep.contains(el) ? 'panel' : 'none');
}, [x, y]);
/** Hit record for a click on the centre of a control: viewport, point, target and panel rects, hit. */
async function hitRecord(p, sel) {
  const at = await center(p, sel);
  return {
    viewport: p.viewportSize(), point: at, target: await rectOf(p, sel),
    panel: await rectOf(p, '#report .help-body'), hit: await hitAt(p, at.x, at.y),
  };
}
/** A point inside the control's rect that is backdrop (not covered by the panel), or null. */
async function backdropPointOver(p, sel) {
  const r = await rectOf(p, sel);
  for (let y = Math.ceil(r.top) + 1; y < r.bottom; y += 2) {
    for (let x = Math.ceil(r.left) + 1; x < r.right; x += 2) {
      if ((await hitAt(p, x, y)) === 'backdrop') return { x, y };
    }
  }
  return null;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await chromium.launch({ headless: true });
  try {
    // AC1 + AC2: Deal clicked just as the report opens.
    {
      let p = null;
      let rec = null;
      const res = await runGraceCheck(async () => {
        if (p) { await p.close().catch(() => {}); p = null; }
        p = await freshPage(b);
        // Read what the press needs while the hand is over and the report is not open yet;
        // once it opens, the press is the very next Playwright call.
        const got = await reachReport(p, async (pg) => ({ before: await rounds(pg), at: await center(pg, '#deal').catch(() => null) }));
        if (!got || !got.read.at) return { ok: false, detail: { reason: 'no shoe report appeared or no #deal point' } };
        const { before, at } = got.read;
        await p.mouse.click(at.x, at.y);
        await p.waitForTimeout(100);
        const closed = !(await reportOpen(p));
        rec = await pressTiming(p);
        await playOut(p);
        const dealt = (await rounds(p)) - before;
        return {
          open: rec.pressMs !== null, pressMs: rec.pressMs, handledMs: rec.handledMs, dealt, extraOk: closed && rec.hit === 'panel',
          detail: {
            point: rec.point, hit: rec.hit, closed, dealt, viewport: p.viewportSize(),
            ...(rec.hit !== 'panel' ? { precondition: 'deal centre is not under the panel' } : {}),
          },
        };
      });
      put('AC1 deal click in grace window deals one round', res.pass, {
        ...res.detail, outcome: res.outcome, reason: res.reason, pressMs: res.pressMs, handledMs: res.handledMs,
        hit: res.detail && res.detail.hit !== undefined ? res.detail.hit : null,
        closed: res.detail && res.detail.closed !== undefined ? res.detail.closed : null,
        dealt: res.detail && res.detail.dealt !== undefined ? res.detail.dealt : null,
        attempts: res.attempts, history: res.history,
      });
      const gate = ac2Gate(checks['AC1 deal click in grace window deals one round'].detail);
      const AC2 = 'AC2 held report reopens for the same shoe between rounds';
      if (gate) {
        put(AC2, false, gate);
      } else {
        const first = { title: rec.title, sub: rec.sub };
        let reopened = false;
        try { await p.waitForFunction(() => document.getElementById('report').open, null, { polling: 'raf', timeout: 1500 }); reopened = true; } catch (e) { /* stays closed */ }
        const again = reopened ? await reportText(p) : null;
        const between = !(await inHand(p));
        put(AC2, reopened && between && again.title === first.title && again.sub === first.sub,
          { closedBefore: true, reopened, between, first, again });
      }
      if (p) await p.close().catch(() => {});
    }
    // AC1b: a point over #deal that is backdrop also deals in the grace window.
    {
      const name = 'AC1b backdrop point over deal in grace window deals one round';
      const vp = await graceCheck(name, b, async (mk) => {
        for (const vp of [VIEWPORT, { width: 1280, height: 1000 }, { width: 1600, height: 1000 }, { width: 900, height: 1200 }]) {
          const p = await mk(vp);
          if (!(await reachReport(p))) throw new Error('no shoe report appeared (AC1b)');
          const pt = await backdropPointOver(p, '#deal');
          if (pt) {
            const before = await rounds(p);
            await p.mouse.click(pt.x, pt.y);
            await p.waitForTimeout(100);
            const closed = !(await reportOpen(p));
            await playOut(p);
            const dealt = (await rounds(p)) - before;
            return { p, pass: closed && dealt === 1, detail: { viewport: vp, point: pt, closed, dealt } };
          }
          await p.close();
        }
        return { p: null, noPress: true, pass: true, detail: { skipped: 'no backdrop point over #deal' } };
      });
      if (vp) await vp.close();
    }
    // AC3: Rebet clicked in the grace window.
    {
      const p = await graceCheck('AC3 rebet click in grace window deals one round at the last bet', b, async (mk) => {
        const p = await mk();
        // Everything is read while the hand is over and the report is not open yet;
        // once it opens, the press is the very next CDP call.
        const got = await reachReport(p, async (pg) => ({
          before: await rounds(pg), rebetOk: await enabled(pg, '#rebet-1'), at: await center(pg, '#rebet-1').catch(() => null),
        }));
        if (!got) throw new Error('no shoe report appeared (AC3)');
        const { before, rebetOk, at } = got.read;
        if (at) await p.mouse.click(at.x, at.y);
        await p.waitForTimeout(100);
        const closed = !(await reportOpen(p));
        await playOut(p);
        const dealt = (await rounds(p)) - before;
        const bet = await p.$eval('#bet', (e) => e.value);
        return { p, pass: !!at && rebetOk && closed && dealt === 1 && bet === '10', detail: { rebetOk, closed, dealt, bet } };
      });
      await p.close();
    }
    // AC4: after the grace window a click on Deal only closes the report.
    {
      const p = await freshPage(b);
      if (!(await reachReport(p))) throw new Error('no shoe report appeared (AC4)');
      const before = await rounds(p);
      await wait(1000);
      const rec = await hitRecord(p, '#deal');
      const at = rec.point;
      await p.mouse.click(at.x, at.y);
      await p.waitForTimeout(150);
      const stillOpen = await reportOpen(p);
      const hand = await inHand(p);
      const dealt = (await rounds(p)) - before;
      const { pressAt } = await pressTiming(p);
      put('AC4 deal click after grace window only closes the report',
        pressAt !== null && pressAt >= GRACE_MS && !hand && dealt === 0 && (rec.hit === 'backdrop' ? !stillOpen : stillOpen),
        { ...rec, stillOpen, hand, dealt, pressAt });
      await p.close();
    }
    // AC5: a backdrop click off the controls in the grace window is ignored.
    {
      const p = await graceCheck('AC5 backdrop click off the controls in grace window is ignored', b, async (mk) => {
        const p = await mk();
        if (!(await reachReport(p))) throw new Error('no shoe report appeared (AC5)');
        const before = await rounds(p);
        await p.mouse.click(4, 4);
        await p.waitForTimeout(100);
        const stillOpen = await reportOpen(p);
        const dealt = (await rounds(p)) - before;
        return { p, pass: stillOpen && dealt === 0, detail: { stillOpen, dealt } };
      });
      await p.close();
    }
    // AC6: the session report (opened by hand) has no grace window.
    {
      const p = await freshPage(b);
      await p.fill('#bet', '10');
      await p.click('#deal');
      await playOut(p);
      await p.waitForTimeout(100);
      const before = await rounds(p);
      await p.click('#report-open');
      const opened = await reportOpen(p);
      const rec = await hitRecord(p, '#deal');
      const at = rec.point;
      await p.mouse.click(at.x, at.y);
      await p.waitForTimeout(150);
      const stillOpen = await reportOpen(p);
      const hand = await inHand(p);
      const dealt = (await rounds(p)) - before;
      put('AC6 session report has no grace window',
        opened && !hand && dealt === 0 && (rec.hit === 'backdrop' ? !stillOpen : stillOpen), { ...rec, opened, stillOpen, hand, dealt });
      await p.close();
    }
    // AC5b: a panel button clicked in the grace window does not act, and the report stays open.
    {
      const p = await graceCheck('AC5b panel button in grace window does not act', b, async (mk) => {
        const p = await mk();
        if (!(await reachReport(p))) throw new Error('no shoe report appeared (AC5b)');
        const dr = [];
        for (const d of ['#deal', '#rebet-1', '#rebet-2']) if (await enabled(p, d)) dr.push(await rectOf(p, d));
        const btns = await p.evaluate(() => [...document.querySelectorAll('#report button')]
          .filter((e) => !e.disabled && e.offsetParent !== null)
          .map((e) => { const r = e.getBoundingClientRect(); return { id: e.id, left: r.left, top: r.top, right: r.right, bottom: r.bottom }; }));
        const clear = btns.find((r) => !dr.some((d) => r.left < d.right && r.right > d.left && r.top < d.bottom && r.bottom > d.top));
        if (!clear) return { p, noPress: true, pass: false, detail: { precondition: 'no panel button clear of the deal controls', btns, dr } };
        const before = await rounds(p);
        await p.mouse.click((clear.left + clear.right) / 2, (clear.top + clear.bottom) / 2);
        await p.waitForTimeout(100);
        const stillOpen = await reportOpen(p);
        const dealt = (await rounds(p)) - before;
        const hand = await inHand(p);
        return { p, pass: stillOpen && dealt === 0 && !hand, detail: { button: clear.id, stillOpen, dealt, hand } };
      });
      await p.close();
    }
  } catch (e) {
    errors.push('HARNESS ' + (e.stack || e.message).split('\n').slice(0, 3).join(' | '));
  }
  await b.close();
  const failed = Object.entries(checks).filter(([, v]) => !v.pass).map(([k]) => k);
  console.log(JSON.stringify({ failed, checks, errors }, null, 1));
  process.exit(failed.length || errors.length ? 1 : 0);
})();
