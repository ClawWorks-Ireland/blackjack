// B99: a click on Deal or Rebet in the shoe report's first 500 ms (the report
// opened by itself, over the controls the player was aiming at) still deals;
// after that, or anywhere else, a backdrop click behaves as before.
// Single-deck table so the cut card comes quickly. Stands on everything.
// Usage: node qa/b99_report_click_check.js <url>
const { chromium } = require('./lib/browser');

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

async function freshPage(b) {
  const p = await b.newPage();
  p.on('pageerror', (e) => errors.push(e.stack || String(e)));
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

/** Deal and play rounds until the shoe report opens by itself between rounds. */
async function reachReport(p) {
  for (let i = 0; i < 80; i++) {
    if (await reportOpen(p)) return true;
    if (await enabled(p, '#deal')) {
      await p.fill('#bet', '10');
      await p.click('#deal');
    }
    await playOut(p);
    try {
      await p.waitForFunction(() => document.getElementById('report').open, null, { polling: 'raf', timeout: 1000 });
      return true;
    } catch (e) { /* no cut card yet */ }
  }
  return false;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await chromium.launch({ headless: true });
  try {
    // AC1 + AC2: Deal clicked just as the report opens.
    {
      const p = await freshPage(b);
      if (!(await reachReport(p))) throw new Error('no shoe report appeared');
      const first = await reportText(p);
      const before = await rounds(p);
      const at = await center(p, '#deal');
      await p.mouse.click(at.x, at.y);
      await p.waitForTimeout(100);
      const closed = !(await reportOpen(p));
      await playOut(p);
      const dealt = (await rounds(p)) - before;
      put('AC1 deal click in grace window deals one round', closed && dealt === 1, { closed, dealt });
      let reopened = false;
      try { await p.waitForFunction(() => document.getElementById('report').open, null, { polling: 'raf', timeout: 1500 }); reopened = true; } catch (e) { /* stays closed */ }
      const again = reopened ? await reportText(p) : null;
      const between = !(await inHand(p));
      put('AC2 held report reopens for the same shoe between rounds',
        reopened && between && again.title === first.title && again.sub === first.sub, { reopened, between, first, again });
      await p.close();
    }
    // AC3: Rebet clicked in the grace window.
    {
      const p = await freshPage(b);
      if (!(await reachReport(p))) throw new Error('no shoe report appeared (AC3)');
      const before = await rounds(p);
      const rebetOk = await enabled(p, '#rebet-1');
      const at = await center(p, '#rebet-1');
      await p.mouse.click(at.x, at.y);
      await p.waitForTimeout(100);
      await playOut(p);
      const dealt = (await rounds(p)) - before;
      const bet = await p.$eval('#bet', (e) => e.value);
      put('AC3 rebet click in grace window deals one round at the last bet', rebetOk && dealt === 1 && bet === '10', { rebetOk, dealt, bet });
      await p.close();
    }
    // AC4: after the grace window a click on Deal only closes the report.
    {
      const p = await freshPage(b);
      if (!(await reachReport(p))) throw new Error('no shoe report appeared (AC4)');
      const before = await rounds(p);
      const at = await center(p, '#deal');
      await wait(1000);
      await p.mouse.click(at.x, at.y);
      await p.waitForTimeout(150);
      const closed = !(await reportOpen(p));
      const hand = await inHand(p);
      const dealt = (await rounds(p)) - before;
      put('AC4 deal click after grace window only closes the report', closed && !hand && dealt === 0, { closed, hand, dealt });
      await p.close();
    }
    // AC5: a backdrop click off the controls in the grace window is ignored.
    {
      const p = await freshPage(b);
      if (!(await reachReport(p))) throw new Error('no shoe report appeared (AC5)');
      const before = await rounds(p);
      await p.mouse.click(4, 4);
      await p.waitForTimeout(100);
      const stillOpen = await reportOpen(p);
      const dealt = (await rounds(p)) - before;
      put('AC5 backdrop click off the controls in grace window is ignored', stillOpen && dealt === 0, { stillOpen, dealt });
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
      const at = await center(p, '#deal');
      await p.mouse.click(at.x, at.y);
      await p.waitForTimeout(150);
      const closed = !(await reportOpen(p));
      const hand = await inHand(p);
      const dealt = (await rounds(p)) - before;
      put('AC6 session report has no grace window', opened && closed && !hand && dealt === 0, { opened, closed, hand, dealt });
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
