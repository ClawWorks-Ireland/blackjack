// B16: the shoe report must never open over a hand in play. Plays shoes
// standing on everything and deals again the moment each round settles, well
// inside the report's 700 ms timer, so the cut-card round is always followed
// by a deal before the report would open. The report must then wait for that
// hand to settle, and still appear before the next deal.
// Usage: node qa/b16_ui_check.js <url> [shoes]
const { chromium } = require('./lib/browser');

const URL_ = process.argv[2];
const SHOES = Number(process.argv[3] || 2);
const checks = {};
const put = (k, pass, detail) => { checks[k] = { pass, detail }; };
const errors = [];

const enabled = (p, s) => p.$eval(s, (e) => !e.disabled && !e.hidden && e.offsetParent !== null).catch(() => false);
const reportOpen = (p) => p.$eval('#report', (d) => d.open).catch(() => false);
const inHand = (p) => p.evaluate(() => document.body.classList.contains('in-hand'));

(async () => {
  const b = await chromium.launch({ headless: true });
  try {
    const p = await b.newPage();
    p.on('pageerror', (e) => errors.push(e.stack || String(e)));
    await p.goto(URL_);
    // speed "off": no card animation, so a round settles the moment it is played.
    await p.evaluate(() => { localStorage.clear(); localStorage.setItem('blackjack.prefs', JSON.stringify({ speed: 'off' })); });
    await p.reload();
    await p.waitForSelector('#deal');
    const seen = { rounds: 0, overHand: 0, betweenRounds: 0 };
    while (seen.betweenRounds < SHOES && seen.rounds < SHOES * 80) {
      if (await reportOpen(p)) { // opened while the table was between rounds: correct
        seen.betweenRounds++;
        await p.evaluate(() => document.getElementById('report').close());
      }
      await p.fill('#bet', '10');
      await p.click('#deal');
      seen.rounds++;
      await p.waitForTimeout(800); // past the 700 ms timer of a report owed by the previous round
      if (await reportOpen(p)) {
        if (await inHand(p)) seen.overHand++;
        else seen.betweenRounds++; // this deal was a natural: the round is already over
        await p.evaluate(() => document.getElementById('report').close());
      }
      for (let s = 0; s < 20 && (await inHand(p)); s++) {
        const target = (await enabled(p, '#no-insure')) ? '#no-insure' : '#stand';
        if (await enabled(p, target)) await p.click(target);
        else await p.waitForTimeout(20);
      }
    }
    put('B16 shoe report never opens over a hand in play', seen.overHand === 0 && seen.betweenRounds >= SHOES, seen);
  } catch (e) {
    errors.push('HARNESS ' + (e.stack || e.message).split('\n').slice(0, 3).join(' | '));
  }
  await b.close();
  const failed = Object.entries(checks).filter(([, v]) => !v.pass).map(([k]) => k);
  console.log(JSON.stringify({ failed, checks, errors }, null, 1));
  process.exit(failed.length || errors.length ? 1 : 0);
})();
