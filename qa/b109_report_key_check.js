// B109: Enter in the shoe report's first 500 ms (the report opened by itself,
// over the controls the player was aiming at) still deals one round; after
// that, or on a report opened by hand, Enter behaves as before.
// Single-deck table so the cut card comes quickly. Stands on everything.
// Usage: node qa/b109_report_key_check.js <url>
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
const bankroll = (p) => p.$eval('#bankroll', (e) => Number(e.textContent.replace(/[^\d]/g, '')));
const active = (p) => p.evaluate(() => document.activeElement && document.activeElement.id);

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
async function reachReport(p, betFor = () => '10') {
  for (let i = 0; i < 80; i++) {
    if (await reportOpen(p)) return true;
    if (await enabled(p, '#deal')) {
      await p.fill('#bet', await betFor(p));
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

(async () => {
  const b = await chromium.launch({ headless: true });
  try {
    // AC1 + AC2: Enter pressed just as the report opens.
    {
      const p = await freshPage(b);
      if (!(await reachReport(p))) throw new Error('no shoe report appeared');
      const first = await reportText(p);
      const before = await rounds(p);
      const focus = await active(p);
      await p.keyboard.press('Enter');
      await p.waitForTimeout(100);
      const closed = !(await reportOpen(p));
      await playOut(p);
      const dealt = (await rounds(p)) - before;
      put('AC1 Enter in grace window deals one round', closed && dealt === 1, { focus, closed, dealt });
      let reopened = false;
      try { await p.waitForFunction(() => document.getElementById('report').open, null, { polling: 'raf', timeout: 1500 }); reopened = true; } catch (e) { /* stays closed */ }
      const again = reopened ? await reportText(p) : null;
      const between = !(await inHand(p));
      put('AC2 held report reopens for the same shoe between rounds',
        reopened && between && again.title === first.title && again.sub === first.sub, { reopened, between, first, again });
      await p.close();
    }
    // AC3: x in the grace window deals one round at twice the last bet.
    {
      const p = await freshPage(b);
      if (!(await reachReport(p))) throw new Error('no shoe report appeared (AC3)');
      const before = await rounds(p);
      const bank = await bankroll(p);
      await p.keyboard.press('x');
      await p.waitForTimeout(100);
      const closed = !(await reportOpen(p));
      const bet = await p.$eval('#bet', (e) => e.value);
      const guess = await p.$eval('#rep-guess', (e) => e.value);
      await playOut(p);
      const dealt = (await rounds(p)) - before;
      put('AC3 x in grace window deals one round at twice the last bet',
        closed && dealt === 1 && bet === '20' && !/x/i.test(guess), { closed, dealt, bet, guess, bank });
      await p.close();
    }
    // AC4: x with Rebet x2 disabled keeps the report open and deals nothing.
    {
      const p = await freshPage(b);
      if (!(await reachReport(p, async (q) => String(Math.min(255, await bankroll(q)))))) throw new Error('no shoe report appeared (AC4)');
      const rebet2Disabled = await p.$eval('#rebet-2', (e) => e.disabled);
      const before = await rounds(p);
      await p.keyboard.press('x');
      await p.waitForTimeout(150);
      const open = await reportOpen(p);
      const dealt = (await rounds(p)) - before;
      put('AC4 x with Rebet x2 disabled keeps the report open and deals nothing',
        rebet2Disabled && open && dealt === 0, { rebet2Disabled, open, dealt });
      await p.close();
    }
    // AC5: after the grace window Enter deals nothing.
    {
      const p = await freshPage(b);
      if (!(await reachReport(p))) throw new Error('no shoe report appeared (AC5)');
      const before = await rounds(p);
      await p.waitForTimeout(1000);
      const focus = await active(p);
      await p.keyboard.press('Enter');
      await p.waitForTimeout(150);
      const dealt = (await rounds(p)) - before;
      const closed = !(await reportOpen(p));
      const guessError = await p.evaluate(() => { const e = document.getElementById('rep-count-result'); return e ? e.textContent.trim() : ''; });
      put('AC5 Enter after grace window deals nothing', dealt === 0, { focus, closed, guessError, dealt });
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
      await p.keyboard.press('Enter');
      await p.keyboard.press('x');
      await p.waitForTimeout(150);
      const dealt = (await rounds(p)) - before;
      put('AC6 session report has no grace window', opened && dealt === 0, { opened, dealt });
      await p.close();
    }
    // AC7: a held Enter (auto-repeat) deals exactly one round.
    {
      const p = await freshPage(b);
      if (!(await reachReport(p))) throw new Error('no shoe report appeared (AC7)');
      const before = await rounds(p);
      const cdp = await p.context().newCDPSession(p);
      const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' };
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, autoRepeat: true });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, autoRepeat: true });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
      await playOut(p);
      const dealt = (await rounds(p)) - before;
      put('AC7 held Enter deals exactly one round', dealt === 1, { dealt });
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
