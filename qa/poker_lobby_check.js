// Browser checks for the lobby's New poker table form (#39 AC5, AC6).
// Usage: node qa/poker_lobby_check.js <snapshot dir> <out dir> <port>
// Starts the snapshot's real live server on 127.0.0.1 with a temp data dir.
const { chromium } = require('./lib/browser');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SNAP = path.resolve(process.argv[2] || '.');
const OUT = process.argv[3] || '.';
const PORT = Number(process.argv[4] || 8766);
const checks = {};
const put = (k, pass, detail) => { checks[k] = { pass: !!pass, detail }; };
const errors = [];

function finish() {
  const report = { checks, errors };
  try { fs.writeFileSync(path.join(OUT, 'poker_lobby.json'), JSON.stringify(report, null, 1)); } catch (_) { /* out dir optional */ }
  console.log(JSON.stringify(report, null, 1));
  process.exit(errors.length || Object.values(checks).some((c) => !c.pass) ? 1 : 0);
}

function startServer(tmp) {
  const child = spawn(process.execPath, [path.join(SNAP, 'server', 'server.js'), '--port', String(PORT), '--host', '127.0.0.1', '--data', path.join(tmp, 'players.json')], { stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = new Promise((resolve, reject) => {
    let seen = '';
    const timer = setTimeout(() => reject(new Error(`server not ready after 10 s: ${seen.slice(-200)}`)), 10000);
    const onData = (d) => { seen += d; if (/Blackjack tables on port/.test(seen)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => { seen += d; });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}) before ready: ${seen.slice(-200)}`)); });
  });
  return { child, ready };
}

const cardsText = (p, sel) => p.$$eval(`${sel} .table-card`, (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
const val = (p, sel) => p.$eval(sel, (e) => e.value);

(async () => {
  const lobbyFile = path.join(SNAP, 'web', 'lobby.html');
  if (!fs.existsSync(lobbyFile) || !/id="new-poker"/.test(fs.readFileSync(lobbyFile, 'utf8'))) {
    console.log(JSON.stringify({ checks: {}, skipped: 'no New poker table form in this commit' }));
    process.exit(0);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poker-lobby-'));
  const { child, ready } = startServer(tmp);
  let browser;
  try {
    try { await ready; } catch (e) { errors.push(`HARNESS ${e.message}`); return; }
    browser = await chromium.launch({ headless: true });
    const p = await (await browser.newContext()).newPage();
    p.on('pageerror', (e) => errors.push(e.stack || String(e)));
    await p.goto(`http://127.0.0.1:${PORT}/web/lobby.html`);

    // 1. Seeded tables (AC6)
    try {
      await p.waitForFunction(() => { const t = document.querySelector('#poker-tables').textContent; return t.includes("Hold'em (with bots)") && /blinds \$5\/\$10/.test(t); }, null, { timeout: 5000 });
    } catch (_) { /* judged below */ }
    const seededCards = await cardsText(p, '#poker-tables');
    const plain = seededCards.some((t) => t.startsWith("Hold'em ") && !t.startsWith("Hold'em (with") && t.includes('blinds $5/$10'));
    const bots = seededCards.some((t) => t.startsWith("Hold'em (with bots)") && t.includes('blinds $5/$10'));
    put('seeded poker tables listed', plain && bots, seededCards);

    // 2. New table appears within 1 s, no reload (AC5)
    await p.evaluate(() => { window.__qaMarker = 1; });
    await p.fill('#new-poker [name=name]', 'QA heads-up');
    await p.fill('#new-poker [name=bigBlind]', '10');
    await p.selectOption('#new-poker [name=bots]', '1');
    await p.fill('#new-poker [name=turnSeconds]', '30');
    await p.click('#new-poker button[type=submit]');
    let appeared = true;
    try {
      await p.waitForFunction(() => [...document.querySelectorAll('#poker-tables .table-card h3')].some((h) => h.textContent === 'QA heads-up'), null, { timeout: 1000 });
    } catch (_) { appeared = false; }
    const marker = await p.evaluate(() => window.__qaMarker);
    const msg = await p.$eval('#poker-msg', (e) => e.textContent.trim());
    const form = { name: await val(p, '#new-poker [name=name]'), bigBlind: await val(p, '#new-poker [name=bigBlind]'), bots: await val(p, '#new-poker [name=bots]'), turnSeconds: await val(p, '#new-poker [name=turnSeconds]') };
    const reset = form.name === '' && form.bigBlind === '10' && form.bots === '0' && form.turnSeconds === '30';
    put('new poker table appears within 1s', appeared && marker === 1 && msg === '' && reset, { appeared, marker, msg, form });

    // 3. Joinable
    const mine = (await cardsText(p, '#poker-tables')).find((t) => t.startsWith('QA heads-up')) || '';
    const btnOk = await p.evaluate(() => {
      const c = [...document.querySelectorAll('#poker-tables .table-card')].find((e) => e.querySelector('h3').textContent === 'QA heads-up');
      const b = c && [...c.querySelectorAll('button')].find((x) => x.textContent === 'Sit down (5 free)');
      return !!b && !b.disabled;
    });
    put('new poker table is joinable', mine.includes('blinds $5/$10 · buy-in $1,000') && mine.includes('Bot 1') && btnOk, { card: mine, btnOk });

    // 4. Failed submit shows the server error
    const countBefore = (await cardsText(p, '#poker-tables')).length;
    const lobbyMsgBefore = await p.$eval('#lobby-msg', (e) => e.textContent);
    await p.evaluate(() => { window.__qaMarker = 1; document.querySelector('#new-poker').noValidate = true; });
    await p.fill('#new-poker [name=name]', 'QA bad');
    await p.fill('#new-poker [name=bigBlind]', '1');
    await p.click('#new-poker button[type=submit]');
    let shown = true;
    try {
      await p.waitForFunction(() => document.querySelector('#poker-msg').textContent.includes('Blinds must be positive'), null, { timeout: 2000 });
    } catch (_) { shown = false; }
    const after = await cardsText(p, '#poker-tables');
    const form2 = { name: await val(p, '#new-poker [name=name]'), bigBlind: await val(p, '#new-poker [name=bigBlind]') };
    const marker2 = await p.evaluate(() => window.__qaMarker);
    const lobbyMsgAfter = await p.$eval('#lobby-msg', (e) => e.textContent);
    put('failed poker submit shows the error',
      shown && !after.some((t) => t.startsWith('QA bad')) && after.length === countBefore && form2.name === 'QA bad' && form2.bigBlind === '1' && marker2 === 1 && lobbyMsgAfter === lobbyMsgBefore,
      { shown, count: [countBefore, after.length], form2, marker2, lobbyMsgBefore, lobbyMsgAfter });

    // 5. Blackjack form still works
    await p.fill('#new [name=name]', 'QA blackjack');
    await p.click('#new button[type=submit]');
    let bj = true;
    try {
      await p.waitForFunction(() => [...document.querySelectorAll('#tables .table-card h3')].some((h) => h.textContent === 'QA blackjack'), null, { timeout: 1000 });
    } catch (_) { bj = false; }
    const bjMsg = await p.$eval('#lobby-msg', (e) => e.textContent.trim());
    put('blackjack form still creates a table', bj && bjMsg === '', { bj, bjMsg });

    // 6. No page errors
    put('no page errors', errors.length === 0, errors.slice(0, 3));
  } catch (e) {
    errors.push(`HARNESS ${(e.stack || e.message).split('\n').slice(0, 3).join(' | ')}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.removeAllListeners('exit');
    child.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
    finish();
  }
})();
