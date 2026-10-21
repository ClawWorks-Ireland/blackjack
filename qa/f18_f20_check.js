// Round 11 engine checks for F18 (report card), F19 (seeded shoes + replay), F20 (count systems).
// Usage: node qa/f18_f20_check.js <snapshot-dir>
const path = require('path');
const snap = path.resolve(process.argv[2]);
const BJ = require(path.join(snap, 'blackjack.js'));
const Counting = require(path.join(snap, 'counting.js'));
const Strategy = require(path.join(snap, 'strategy.js'));
const Report = require(path.join(snap, 'report.js'));
const Replay = require(path.join(snap, 'replay.js'));
const Drill = require(path.join(snap, 'drill.js'));

const checks = {};
const put = (name, pass, detail) => { checks[name] = detail === undefined ? { pass } : { pass, detail }; };
const code = (c) => `${c.rank}${c.suit}`;

// My own tag tables (from the published systems), by rank.
const MINE = {
  hilo: { 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 0, 8: 0, 9: 0, 10: -1, J: -1, Q: -1, K: -1, A: -1 },
  ko: { 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 0, 9: 0, 10: -1, J: -1, Q: -1, K: -1, A: -1 },
  ho2: { 2: 1, 3: 1, 4: 2, 5: 2, 6: 1, 7: 1, 8: 0, 9: 0, 10: -2, J: -2, Q: -2, K: -2, A: 0 },
  om2: { 2: 1, 3: 1, 4: 2, 5: 2, 6: 2, 7: 1, 8: 0, 9: -1, 10: -2, J: -2, Q: -2, K: -2, A: 0 },
};
const myTag = (c, s) => MINE[s][c.rank];

function rngOf(seed) { return BJ.seededRng(seed); }

function playBasic(g, rng) {
  let guard = 0;
  while ((g.phase === 'player' || g.phase === 'insurance') && guard++ < 50) {
    if (g.phase === 'insurance') { rng() < 0.3 ? g.takeInsurance() : g.declineInsurance(); continue; }
    const h = g.currentHand;
    const allowed = { canDouble: g.canDouble(), canSplit: g.canSplit(), canSurrender: g.canSurrender(), canHit: g.canHit() };
    let a = Strategy.recommend(h.cards, g.dealer[0], allowed, g.rules).action;
    if (rng() < 0.1) { // some off-strategy moves so replay covers every action
      const opts = ['hit', 'stand']; if (allowed.canDouble) opts.push('double'); if (allowed.canSplit) opts.push('split'); if (allowed.canSurrender) opts.push('surrender');
      a = opts[Math.floor(rng() * opts.length)];
    }
    if (a === 'hit' && !allowed.canHit) a = 'stand';
    g[a]();
  }
}

// ---------- F19 ----------
function dealShoes(seed, nShoes, decks = 6) {
  const g = new BJ.Game({ bankroll: 1e9, decks, seed, shoeNo: 1 });
  const rng = rngOf(99);
  const shoes = [[]];
  let lastNo = g.shoeNo;
  // Record each shoe's full card order at its start.
  shoes[0] = g.shoe.map(code).join('');
  const seen = [shoes[0]];
  while (seen.length < nShoes) {
    g.deal(10);
    playBasic(g, rng);
    if (g.shoeNo !== lastNo) { lastNo = g.shoeNo; }
    if (g.cutCardReached) {
      g.deal(10); // freshShoe happens here
      const fresh = g.drawLog.slice();
      // reconstruct: shoe order = drawn cards (in draw order) + remaining shoe reversed... compare via seededShoe directly
      seen.push({ no: g.shoeNo, firstDrawn: fresh.map(code).join('') });
      playBasic(g, rng);
    }
  }
  return { g, seen };
}
{
  const a = dealShoes('qa-seed', 10);
  const b = dealShoes('qa-seed', 10);
  const same = JSON.stringify(a.seen) === JSON.stringify(b.seen);
  const c = dealShoes('qa-seed2', 10);
  const differs = JSON.stringify(a.seen.slice(1)) !== JSON.stringify(c.seen.slice(1));
  // Each shoe n equals seededShoe(decks, seed, n) - checked via the first cards drawn after the reshuffle.
  let matchesSeededShoe = true;
  for (const s of a.seen.slice(1)) {
    const shoe = BJ.seededShoe(6, 'qa-seed', s.no).map(code);
    const top = shoe.slice().reverse().slice(0, s.firstDrawn.length / 2).join(''); // approx: codes are 2-3 chars
    const expect = shoe.slice().reverse().join('');
    if (!expect.startsWith(s.firstDrawn)) matchesSeededShoe = false;
    void top;
  }
  // "lucky-7" starts at shoe 7 = the 7th shoe of "lucky".
  const p = BJ.parseSeed('lucky-7');
  const g7 = new BJ.Game({ decks: 6, ...p });
  const shoe7 = BJ.seededShoe(6, 'lucky', 7).map(code).join('');
  const parse = { p, same7: g7.shoe.map(code).join('') === shoe7, blank: BJ.parseSeed('  '), bad: BJ.parseSeed('a b'), long: BJ.parseSeed('x'.repeat(41)) };
  // Save/restore keeps the seed and shoe number.
  const g = new BJ.Game({ decks: 6, seed: 'qa', shoeNo: 4 });
  const restored = BJ.Game.fromJSON ? BJ.Game.fromJSON(JSON.parse(JSON.stringify(g.toJSON()))) : null;
  put('F19 same seed deals identical cards for 10 shoes; another seed differs', same && differs && matchesSeededShoe && a.seen.length === 10,
    { shoes: a.seen.length, same, differs, matchesSeededShoe });
  put('F19 seed text parses ("x-7" = shoe 7) and bad text is refused', parse.same7 && parse.p.seed === 'lucky' && parse.p.shoeNo === 7 && !parse.blank && !parse.bad && !parse.long, parse);
  put('F19 seed and shoe number survive save/restore', !!restored && restored.shoeSeed === 'qa-4' && restored.shoe.map(code).join('') === g.shoe.map(code).join(''),
    { shoeSeed: restored && restored.shoeSeed });
}
{
  // Replay: play many rounds (1-3 spots, side bets, insurance, off-strategy moves) and rebuild each.
  const rng = rngOf(7);
  const rulesets = [{}, { h17: true, decks: 2 }, { enhc: true, obo: true }, { enhc: true }, { rsa: true, das: false }, { doubleOn: '10-11', lateSurrender: false }];
  let n = 0; const bad = [];
  for (const rs of rulesets) {
    const g = new BJ.Game({ bankroll: 1e7, decks: rs.decks || 6, seed: 'rp', ...rs });
    for (let i = 0; i < 1500; i++) {
      const spots = 1 + Math.floor(rng() * 3);
      const before = { bankroll: g.bankroll, running: 0, unseen: 0 };
      const cs = Counting.countState(g); before.running = cs.running; before.unseen = cs.unseen;
      const side = rng() < 0.3 ? { pairs: 5, t213: 5 } : {};
      g.deal(spots === 1 ? 10 : Array(spots).fill(10), side);
      playBasic(g, rng);
      const rec = JSON.parse(JSON.stringify(Replay.recordOf(g, before)));
      const r = Replay.replayRound(rec);
      const want = { dealer: g.dealer.map(code), net: g.net, hands: g.hands.map((h, k) => ({ cards: h.cards.map(code), total: BJ.handValue(h.cards).total, outcome: g.results[k].outcome, net: g.results[k].net })) };
      const got = { dealer: r.final.dealer.map(code), net: r.final.net, hands: r.final.hands.map((h) => ({ ...h, cards: h.cards.map(code) })) };
      n++;
      if (!r.complete || JSON.stringify(want) !== JSON.stringify(got)) { if (bad.length < 5) bad.push({ rs, i, want, got, complete: r.complete }); }
    }
  }
  put('F19 replay reproduces every hand, total, result and net (9,000 rounds, 6 rule sets)', bad.length === 0, { rounds: n, mismatches: bad.length, sample: bad.slice(0, 2) });
}

// ---------- F20 ----------
{
  const sums = {};
  for (const s of ['hilo', 'ko', 'ho2', 'om2']) {
    const deck = BJ.createShoe(1);
    const tagsMatch = deck.every((c) => Counting.tagOf(c, s) === myTag(c, s));
    sums[s] = { mine: deck.reduce((t, c) => t + myTag(c, s), 0), game: Counting.deckTotal(s, 1), tagsMatch, six: Counting.deckTotal(s, 6) };
  }
  put('F20 full deck sums: Hi-Lo 0, Hi-Opt II 0, Omega II 0, KO +4; tags match the published tables',
    sums.hilo.mine === 0 && sums.ho2.mine === 0 && sums.om2.mine === 0 && sums.ko.mine === 4 && Object.values(sums).every((x) => x.tagsMatch && x.game === x.mine), sums);
}
{
  // Running count follows the system: deal a shoe to the cut and compare with my own tally of seen cards.
  const probs = [];
  for (const s of ['hilo', 'ko', 'ho2', 'om2']) for (const decks of [1, 2, 6, 8]) {
    const g = new BJ.Game({ bankroll: 1e9, decks, seed: `rc-${s}`, penetration: 0.75 });
    const rng = rngOf(3);
    let seen = [];
    for (let i = 0; i < 400; i++) {
      if (g.cutCardReached) break;
      g.deal(10);
      playBasic(g, rng);
      seen = seen.concat(g.drawLog);
      const st = Counting.systemState(g, s);
      const mine = (s === 'ko' ? 4 - 4 * decks : 0) + seen.reduce((t, c) => t + myTag(c, s), 0);
      const unseen = decks * 52 - seen.length;
      if (st.running !== mine || st.unseen !== unseen) { probs.push({ s, decks, i, game: st.running, mine }); break; }
      if (s !== 'ko' && s !== 'hilo' && Math.abs(st.trueCount - mine / Math.max(0.5, unseen / 52)) > 1e-9) { probs.push({ s, decks, i, tc: st.trueCount }); break; }
      if (s === 'ko' && st.trueCount !== null) { probs.push({ s, decks, i, koTrue: st.trueCount }); break; }
    }
  }
  put('F20 running/true count follows the chosen system (4 systems x 1/2/6/8 decks, whole shoes)', probs.length === 0, probs.slice(0, 3));
}
{
  // KO: full shoe ends at +4; key and pivot; bet count mapping.
  const k = {};
  for (const d of [1, 2, 6, 8]) k[d] = { start: Counting.koStart(d), end: Counting.koStart(d) + Counting.deckTotal('ko', d), key: Counting.KO_KEY[d] };
  const map = [Counting.koBetCount(Counting.KO_KEY[6], Counting.KO_KEY[6]), Counting.koBetCount(4, Counting.KO_KEY[6])];
  put('F20 KO: IRC 4-4xdecks, whole shoe ends at +4, key maps to +2 and pivot to +4',
    Object.values(k).every((x) => x.end === 4) && k[1].start === 0 && k[6].start === -20 && map[0] === 2 && map[1] === 4, { k, keyPivotMap: map });
}
{
  // Ace side count: two unseen piles with the same main count, different aces. Bets differ; insurance and plays do not.
  const mk = (aces) => {
    const g = new BJ.Game({ decks: 1, seed: 'ace' });
    // unseen = 26 cards: `aces` aces, rest neutral 8/9 for ho2 (tag 0) plus tens/low to fix the count.
    const cards = [];
    for (let i = 0; i < aces; i++) cards.push({ rank: 'A', suit: '♠' });
    while (cards.length < 26) cards.push({ rank: '8', suit: '♥' });
    g.shoe = cards;
    return g;
  };
  const rich = Counting.systemState(mk(4), 'ho2');
  const poor = Counting.systemState(mk(0), 'ho2');
  const richO = Counting.systemState(mk(4), 'om2');
  const poorO = Counting.systemState(mk(0), 'om2');
  const pass = rich.running === poor.running && rich.trueCount === poor.trueCount && rich.betCount > poor.betCount
    && rich.insurance === poor.insurance && richO.betCount > poorO.betCount && richO.insurance === poorO.insurance
    && rich.aceSurplus > 0 && poor.aceSurplus < 0;
  put('F20 ace side count moves the bet only (same running/true count and insurance, ace-rich bets more)', pass,
    { ho2: { rich: { tc: rich.trueCount, bet: rich.betCount, ins: rich.insurance }, poor: { tc: poor.trueCount, bet: poor.betCount, ins: poor.insurance } } });
}
{
  // Insurance thresholds: my own measurement. For random partial shoes, group by the system count and find the lowest
  // whole count where the mean of 3*P(ten)-1 over the unseen cards (hole card included) is > 0.
  const res = {};
  for (const s of ['hilo', 'ko', 'ho2', 'om2']) for (const decks of [1, 6]) {
    const bins = new Map();
    const rng = rngOf(1234 + decks);
    for (let t = 0; t < (decks === 1 ? 300000 : 150000); t++) {
      const shoe = BJ.shuffle(BJ.createShoe(decks), rng);
      const cut = Math.floor(rng() * (decks * 52 * 0.8));
      const seen = shoe.slice(0, cut); const unseen = shoe.slice(cut);
      let running = (s === 'ko' ? 4 - 4 * decks : 0) + seen.reduce((x, c) => x + myTag(c, s), 0);
      const key = s === 'ko' ? running : Math.floor(running / (unseen.length / 52));
      const tens = unseen.filter((c) => BJ.cardValue(c) === 10).length;
      const ev = (3 * tens) / unseen.length - 1;
      const b = bins.get(key) || [0, 0]; b[0] += ev; b[1]++; bins.set(key, b);
    }
    const keys = [...bins.keys()].filter((k) => bins.get(k)[1] >= 400).sort((a, b) => a - b);
    const firstPos = keys.find((k) => k >= -2 && bins.get(k)[0] / bins.get(k)[1] > 0 && keys.filter((j) => j > k).every((j) => bins.get(j)[0] / bins.get(j)[1] > -0.01));
    res[`${s}/${decks}D`] = { mine: firstPos, game: Counting.INSURANCE_AT[s](decks) };
  }
  const ok = Object.values(res).every((x) => x.mine !== undefined && Math.abs(x.mine - x.game) <= 1);
  put('F20 insurance index per system within 1 of my own measurement', ok, res);
}
{
  // Count drill answers follow the system.
  const probs = [];
  for (const s of ['hilo', 'ko', 'ho2', 'om2']) {
    const full = Drill.countDeal(52, rngOf(5), s);
    if (full.answer !== (s === 'ko' ? 4 : 0)) probs.push({ s, full: full.answer });
    for (let i = 0; i < 500; i++) {
      const d = Drill.countDeal(1 + (i % 52), rngOf(i), s);
      const mine = d.cards.reduce((t, c) => t + myTag(c, s), 0);
      if (mine !== d.answer) { probs.push({ s, i, mine, game: d.answer }); break; }
    }
  }
  put('F20 count drill answer = the chosen system tag sum (full deck 0 / KO +4)', probs.length === 0, probs);
}
{
  // Bet ramp follows the system's bet count, and index plays stay Hi-Lo only (countSpot returns null for other systems).
  const g = new BJ.Game({ decks: 6, seed: 'idx' });
  let found = null;
  for (let i = 0; i < 20000 && !found; i++) {
    if (g.phase !== 'player' && g.phase !== 'insurance') g.deal(10);
    if (g.phase === 'insurance') { g.declineInsurance(); continue; }
    if (g.phase !== 'player') continue;
    const spot = Report.countSpot(g, 'hilo');
    if (spot && spot.play !== 'insurance') found = { hilo: spot, ho2: Report.countSpot(g, 'ho2'), ko: Report.countSpot(g, 'ko') };
    else g.stand();
  }
  put('F20 index plays are Hi-Lo only: a Hi-Lo deviation spot is not graded under KO/Hi-Opt II', !!found && found.ho2 === null && found.ko === null, found);
}

// ---------- F18 ----------
{
  const rng = rngOf(11);
  const perfect = Report.newShoe(); const flat = Report.newShoe(); const half = Report.newShoe();
  for (let i = 0; i < 80; i++) {
    const tc = Math.round((rng() * 8 - 3) * 10) / 10;
    const sug = Counting.suggestedBet(tc, { min: 5, unit: 5, max: 500, bankroll: 1e6 });
    Report.recordBet(perfect, { bet: sug, suggested: sug, unit: 5, spots: 1, tc });
    Report.recordResult(perfect, { net: rng() < 0.5 ? sug : -sug });
    Report.recordBet(flat, { bet: 10, suggested: sug, unit: 5, spots: 1, tc });
    Report.recordResult(flat, { net: 0 });
    Report.recordBet(half, { bet: rng() < 0.5 ? sug : 5, suggested: sug, unit: 5, spots: 1, tc });
    Report.recordResult(half, { net: 0, evLost: 0.5 });
  }
  Report.recordSpot(perfect, { hand: '10,6', up: '10', tc: 1, index: 0, play: 'stand', move: 'stand' });
  Report.recordSpot(perfect, { hand: '10,2', up: '3', tc: 3, index: 2, play: 'stand', move: 'stand' });
  const p = Report.grade(perfect, { houseEdge: 0.4 });
  const f = Report.grade(flat, { houseEdge: 0.4 });
  const h = Report.grade(half, { houseEdge: 0.4 });
  put('F18 perfect counter: r = 1, 100% within a unit, every index taken, skill gap 0', p.r > 0.99999 && p.within === 1 && p.taken === p.spots && Math.abs(p.skillGap) < 1e-9,
    { r: p.r, within: p.within, idx: `${p.taken}/${p.spots}`, gap: p.skillGap });
  put('F18 flat betting: r not measurable, with a plain message', f.r === null && /Flat betting/.test(f.betNote || ''), { r: f.r, note: f.betNote });
  put('F18 a sloppy counter scores lower r, positive skill gap', h.r < p.r && h.skillGap > 0, { r: h.r, gap: h.skillGap, evLost: h.evLost });
  // Luck + expected = net.
  put('F18 luck = net - expected', Math.abs(p.luck - (p.net - p.expected)) < 1e-9);
  // CSV
  let reports = [];
  for (const s of [perfect, flat, half]) reports = Report.addReport(reports, Report.summary({ ...s, shoeSeed: 'qa-1' }, { houseEdge: 0.4 }, Date.UTC(2026, 8, 28)));
  const field = (v) => { const t = String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const csv = Report.reportsCSV(reports, field);
  const lines = csv.trim().split('\n');
  const cols = lines[0].split(',').length;
  put('F18 shoe reports export as CSV (header + one row per shoe, flat r blank)', lines.length === 4 && cols === Report.REPORT_COLUMNS.length && lines[2].split(',')[3] === '',
    { header: lines[0], rows: lines.slice(1) });
  // Saved reports: capped at 20, bad JSON ignored.
  let many = []; for (let i = 0; i < 25; i++) many = Report.addReport(many, { rounds: i });
  put('F18 saved reports capped at 20; corrupt storage is ignored', many.length === 20 && Report.parseReports('{bad').length === 0 && Report.parseReports(JSON.stringify(many)).length === 20);
}

const failed = Object.entries(checks).filter(([, v]) => !v.pass).map(([k]) => k);
console.log(JSON.stringify({ failed, checks }, null, 1));
