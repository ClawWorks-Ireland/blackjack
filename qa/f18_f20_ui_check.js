// Round 11 browser checks for F18 report card, F19 seeds/replay/play-again, F20 count systems.
// Usage: node qa/f18_f20_ui_check.js <served index.html URL> <out dir>
const { chromium } = require('./lib/browser');
const fs = require('fs');
const path = require('path');
const URL_ = process.argv[2];
const OUT = process.argv[3] || '.';
const checks = {};
const put = (k, pass, detail) => { checks[k] = { pass, detail }; };
const errors = [];

const ADV = { hit: '#hit', stand: '#stand', double: '#double', split: '#split', surrender: '#surrender', insurance: '#insure', 'no-insurance': '#no-insure' };
const BTN = ['#hit', '#stand', '#double', '#split', '#surrender', '#insure', '#no-insure'];

async function fresh(ctx, ls = {}) {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.stack || String(e)));
  await p.goto(URL_);
  await p.evaluate((ls) => { localStorage.clear(); localStorage.setItem('blackjack.prefs', JSON.stringify({ speed: 'off' })); for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, v); }, ls);
  await p.reload();
  await p.waitForSelector('#deal');
  return p;
}
const enabled = (p, s) => p.$eval(s, (e) => !e.disabled && !e.hidden && e.offsetParent !== null).catch(() => false);
const text = (p, s) => p.$eval(s, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => null);
const isOpen = (p, id) => p.$eval(`#${id}`, (d) => d.open).catch(() => false);
async function closeDialogs(p) { await p.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close())); }
async function setCount(p, on) {
  const pressed = await p.$eval('#count-toggle', (e) => e.getAttribute('aria-pressed') === 'true');
  if (pressed !== on) await p.click('#count-toggle');
}
async function suggestedButton(p) {
  await p.click('#hint');
  await p.waitForTimeout(20);
  const id = await p.evaluate(() => { const b = document.querySelector('button.suggested'); return b ? b.id : null; });
  const hint = await text(p, '#hint-text');
  return { id, hint };
}
async function waitIdle(p) {
  for (let i = 0; i < 100; i++) {
    let any = false;
    for (const b of BTN) if (await enabled(p, b)) { any = true; break; }
    if (!any && (await enabled(p, '#deal'))) return true;
    if (any) return false;
    await p.waitForTimeout(30);
  }
  return false;
}

/**
 * One round. mode: 'perfect' (count shown for bet + moves), 'head' (read the count play with the count shown,
 * then hide the count and act: an in-head counter), 'flat' (flat bet, basic hint, count hidden), 'stand'.
 */
async function round(p, mode, flatBet = 10, log = []) {
  let reportOpened = false;
  if (await isOpen(p, 'report')) { reportOpened = true; await closeDialogs(p); }
  let bet = flatBet;
  if (mode === 'perfect' || mode === 'head') {
    await setCount(p, true);
    if (await enabled(p, '#suggest-bet')) { await p.click('#suggest-bet'); bet = Number(await p.inputValue('#bet')); }
    if (mode === 'head') await setCount(p, false);
  } else { await setCount(p, false); await p.fill('#bet', String(flatBet)); }
  if (mode !== 'perfect' && mode !== 'head') await p.fill('#bet', String(flatBet));
  await p.click('#deal');
  for (let s = 0; s < 30; s++) {
    await p.waitForTimeout(15);
    if (await waitIdle(p)) break;
    let target;
    if (mode === 'stand') target = (await enabled(p, '#no-insure')) ? '#no-insure' : '#stand';
    else {
      if (mode === 'perfect' || mode === 'head') await setCount(p, true);
      const sb = await suggestedButton(p);
      if (/Count play/.test(sb.hint || '')) log.push(sb.hint);
      if (mode === 'head') await setCount(p, false);
      target = sb.id ? `#${sb.id}` : '#stand';
    }
    if (await enabled(p, target)) await p.click(target); else if (await enabled(p, '#stand')) await p.click('#stand');
  }
  await p.waitForTimeout(850); // the shoe report opens 700 ms after the last round of a shoe settles
  return { bet, reportOpened: reportOpened || (await isOpen(p, 'report')) };
}
async function readReport(p) {
  const ids = ['report-title', 'report-sub', 'rep-r', 'rep-within', 'rep-index', 'rep-checks', 'rep-net', 'rep-expected', 'rep-luck', 'rep-perfect', 'rep-gap', 'rep-ev', 'rep-note', 'rep-missed'];
  const o = {};
  for (const id of ids) o[id] = await text(p, `#${id}`);
  o.noteHidden = await p.$eval('#rep-note', (e) => e.hidden);
  o.againVisible = await p.$eval('#report-again', (e) => !e.hidden);
  return o;
}
async function playToShoeEnd(p, mode, max = 90, log = []) {
  for (let i = 0; i < max; i++) {
    const r = await round(p, mode, 10, log);
    if (await isOpen(p, 'report')) return { rounds: i + 1, report: await readReport(p) };
    void r;
  }
  return { rounds: max, report: null };
}
async function replayOptions(p) {
  await closeDialogs(p);
  await p.keyboard.press('l');
  await p.waitForTimeout(100);
  const opened = await isOpen(p, 'replay');
  const opts = await p.$$eval('#replay-pick option', (os) => os.map((o) => ({ v: o.value, t: o.textContent })));
  return { opened, opts };
}
async function replayFinal(p, value) {
  await p.selectOption('#replay-pick', value);
  for (let i = 0; i < 60 && (await enabled(p, '#replay-next')); i++) await p.click('#replay-next');
  const hands = await p.$$eval('#replay-hands .player-hand h2', (hs) => hs.map((h) => h.textContent));
  return { hands, text: await text(p, '#replay-text'), dealer: await text(p, '#replay-dealer-total') };
}

(async () => {
  const b = await chromium.launch({ headless: true });
  try {
    // ---- F18 A: perfect counter with the count shown ----
    {
      const p = await fresh(await b.newContext());
      const log = [];
      const res = await playToShoeEnd(p, 'perfect', 90, log);
      await p.screenshot({ path: path.join(OUT, 'f18-report-perfect.png') });
      const r = res.report || {};
      put('F18 perfect counter (count shown): r 1.00, 100% within a unit, every index taken, skill gap $0',
        !!res.report && r['rep-r'] === '1.00' && r['rep-within'] === '100%' && /^(\d+) of \1$|None came up/.test(r['rep-index']) && /^\+?\$0(\.00)?$/.test(r['rep-gap']) && /^\$0(\.00)?$/.test(r['rep-ev']),
        { rounds: res.rounds, report: r, countPlays: log.slice(0, 6) });
      // Play this shoe again appears on the shoe report
      put('F18/F19 shoe report offers "Play this shoe again"', !!r.againVisible);
      await p.close();
    }
    // ---- F18 A': the same perfect counter, counting in their head (count hidden when acting) ----
    {
      const p = await fresh(await b.newContext());
      const log = [];
      const res = await playToShoeEnd(p, 'head', 90, log);
      const r = res.report || {};
      const acc = await text(p, '#stat-accuracy').catch(() => null);
      await closeDialogs(p);
      const hist = await p.$$eval('#history li', (ls) => ls.map((l) => l.textContent.replace(/\s+/g, ' ').trim()).filter((t) => /cost|Mistake|mistake/i.test(t)).slice(0, 5));
      put('F18 perfect in-head counter (count hidden): skill gap $0 and no EV "given away"',
        !!res.report && /^\+?\$0(\.00)?$/.test(r['rep-gap']) && /^\$0(\.00)?$/.test(r['rep-ev']) && /^(\d+) of \1$|None came up/.test(r['rep-index']),
        { rounds: res.rounds, report: r, countPlaysTaken: log.slice(0, 8), historyMistakes: hist, acc });
      await p.close();
    }
    // ---- F18 B: flat bettor, count hidden ----
    {
      const p = await fresh(await b.newContext());
      for (let i = 0; i < 12; i++) await round(p, 'flat', 10);
      await closeDialogs(p);
      await p.keyboard.press('e');
      await p.waitForTimeout(100);
      const r = await readReport(p);
      await p.screenshot({ path: path.join(OUT, 'f18-report-flat.png') });
      put('F18 flat betting with count hidden: E opens the session report, r not measurable, flat-betting message',
        (await isOpen(p, 'report')) && r['rep-r'] === 'Not measurable' && !r.noteHidden && /Flat betting/.test(r['rep-note'] || ''), r);
      await p.close();
    }
    // ---- F19: seed via Table rules, same cards in a second browser, reload, replay, play again ----
    {
      const runSeeded = async () => {
        const ctx = await b.newContext();
        const p = await fresh(ctx);
        await p.click('#rules-open');
        await p.fill('#set-seed', 'qa-r11');
        await p.click('#set-apply');
        await p.waitForTimeout(100);
        const seedText = await text(p, '#seed-text');
        for (let i = 0; i < 10; i++) await round(p, 'stand', 10);
        const ro = await replayOptions(p);
        return { ctx, p, seedText, opts: ro.opts.map((o) => o.t.replace(/^Round \d+: /, '')), raw: ro.opts, opened: ro.opened };
      };
      const A = await runSeeded();
      const B = await runSeeded();
      put('F19 seed "qa-r11" deals the same 10 rounds in two separate browsers', A.opts.length === 10 && JSON.stringify(A.opts) === JSON.stringify(B.opts),
        { seedText: A.seedText, a: A.opts.slice(-3), b: B.opts.slice(-3) });
      put('F19 L opens the replay with the last rounds', A.opened && A.opts.length === 10);
      // Replay final state vs the history line for every round.
      const bad = [];
      for (const o of A.raw) {
        const f = await replayFinal(A.p, o.v);
        const totals = [...o.t.matchAll(/\((\d+|soft \d+|BJ|Blackjack)\)/g)].map((m) => m[1]);
        const rtotals = f.hands.map((h) => (h.match(/\(([^)]+)\)/) || [])[1]);
        const norm = (x) => String(x).replace(/^soft /, '');
        if (!/^Result:/.test(f.text || '') || totals.length !== rtotals.length || totals.some((t, i) => !String(rtotals[i]).includes(norm(t)) && !/BJ|Blackjack/.test(t))) bad.push({ o: o.t, f });
      }
      put('F19 replay of each stored round ends on the same hands and totals, with a result line', bad.length === 0, { checked: A.raw.length, bad: bad.slice(0, 3) });
      await A.p.screenshot({ path: path.join(OUT, 'f19-replay.png') });
      // Reload keeps the seed.
      await closeDialogs(A.p);
      const before = await text(A.p, '#seed-text');
      await A.p.reload(); await A.p.waitForSelector('#deal');
      const after = await text(A.p, '#seed-text');
      put('F19 seed survives a reload', before === after && /qa-r11/.test(after || ''), { before, after });
      // Finish the shoe, then "Play this shoe again" and compare the first 10 rounds.
      let opened = false;
      for (let i = 0; i < 90 && !opened; i++) { await round(A.p, 'stand', 10); opened = await isOpen(A.p, 'report'); }
      const rep = opened ? await readReport(A.p) : null;
      let again = null;
      if (opened && rep.againVisible) {
        await A.p.click('#report-again');
        await A.p.waitForTimeout(100);
        const msg = await text(A.p, '#message');
        for (let i = 0; i < 10; i++) await round(A.p, 'stand', 10);
        const ro = await replayOptions(A.p);
        const first10 = ro.opts.slice(0, 10).map((o) => o.t.replace(/^Round \d+: /, ''));
        again = { msg, same: JSON.stringify(first10) === JSON.stringify(A.opts), first10: first10.slice(-2), orig: A.opts.slice(-2), seedText: await text(A.p, '#seed-text') };
      }
      put('F19 "Play this shoe again" restarts the same seed: first 10 rounds identical', !!again && again.same, { reportOpened: opened, again });
      await A.ctx.close(); await B.ctx.close();
    }
    // ---- F20: KO and Hi-Opt II on the table, drill follows the system ----
    {
      const res = {};
      for (const sys of ['ko', 'ho2', 'om2']) {
        const p = await fresh(await b.newContext(), { 'blackjack.prefs': JSON.stringify({ speed: 'off', countSystem: sys }) });
        await setCount(p, true);
        const panel = { name: await text(p, '#count-system'), label: await text(p, '#count-true-label'), trueTxt: await text(p, '#count-true'), note: await text(p, '#count-note'), decks: await text(p, '#count-decks'), running: await text(p, '#count-running'), suggest: await text(p, '#suggest-text') };
        const log = [];
        for (let i = 0; i < 25; i++) await round(p, 'perfect', 10, log);
        const nonIns = log.filter((h) => !/insurance|even money/i.test(h));
        res[sys] = { panel, countPlays: log.slice(0, 3), nonInsuranceCountPlays: nonIns.length };
        if (sys === 'ko') await p.screenshot({ path: path.join(OUT, 'f20-ko-panel.png') });
        // Drill: 52 cards at 0.3 s; the full deck is +4 for KO, 0 otherwise.
        await closeDialogs(p);
        await p.keyboard.press('w'); await p.click('#tab-count');
        await p.selectOption('#cd-size', '52'); await p.selectOption('#cd-speed', '300');
        await p.click('#cd-start');
        await p.waitForSelector('#cd-form:not([hidden])', { timeout: 60000 });
        const want = sys === 'ko' ? '+4' : '0';
        await p.fill('#cd-guess', want); await p.press('#cd-guess', 'Enter'); await p.waitForTimeout(200);
        res[sys].drill = await text(p, '#cd-result');
        await p.close();
      }
      put('F20 KO panel: running count starts at -20 (6 decks), key/pivot shown instead of a true count',
        res.ko.panel.running === '-20' && res.ko.panel.label === 'Key' && /pivot \+4/.test(res.ko.panel.trueTxt) && /running count/.test(res.ko.panel.suggest || ''), res.ko.panel);
      put('F20 level-2 panels show the ace side count and say index plays are Hi-Lo only',
        ['ho2', 'om2'].every((s) => /aces left/.test(res[s].panel.decks) && /Index plays use Hi-Lo/.test(res[s].panel.note)) && /Index plays use Hi-Lo/.test(res.ko.panel.note),
        { ho2: res.ho2.panel, om2: res.om2.panel });
      put('F20 no Hi-Lo index plays in the coach under KO / Hi-Opt II / Omega II (75 rounds)', ['ko', 'ho2', 'om2'].every((s) => res[s].nonInsuranceCountPlays === 0),
        Object.fromEntries(Object.entries(res).map(([k, v]) => [k, v.countPlays])));
      put('F20 count drill: full deck is +4 in KO, 0 in Hi-Opt II / Omega II', ['ko', 'ho2', 'om2'].every((s) => /^Right/.test(res[s].drill || '')),
        Object.fromEntries(Object.entries(res).map(([k, v]) => [k, v.drill])));
    }
  } catch (e) { try { const pg = b.contexts().flatMap((c) => c.pages()).pop(); if (pg) { await pg.screenshot({ path: path.join(OUT, "f18-harness-fail.png") }); errors.push("OPEN " + JSON.stringify(await pg.evaluate(() => [...document.querySelectorAll("dialog[open]")].map((d) => d.id + ":" + d.textContent.replace(/\s+/g, " ").slice(0, 300))))); } } catch {} errors.push("HARNESS " + (e.stack || e.message).split('\n').slice(0, 3).join(' | ')); }
  await b.close();
  const failed = Object.entries(checks).filter(([, v]) => !v.pass).map(([k]) => k);
  const out = { failed, checks, errors };
  fs.writeFileSync(path.join(OUT, 'f18_f20_ui.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
})();
