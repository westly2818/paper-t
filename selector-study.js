// Which stocks and which moments should the opening-range rules trade? Uses the hypothetical trades from running the live rules on ALL
// stocks (ranking-test.js --shortlist 200 with no position limits), so there are thousands of trades instead of a few hundred.
//   node selector-study.js --glob "data/ranking-all_c*"
// Method (fixed in advance): every trade carries what was known at entry. Rules are searched on the FIRST half of the sessions only,
// then tested on the SECOND half they never saw. A control repeats the same search on shuffled outcomes, to show how good a rule can
// look by pure luck. Results are net R per trade (after charges); t-statistics are clustered by day because stocks on one day move together.
const fs = require('fs');
const path = require('path');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const GLOB = arg('glob', 'data/ranking-all_c*'), MINTRAIN = +arg('min-train', 300), SHUF = +arg('shuffles', 20);
const root = path.dirname(GLOB), prefix = path.basename(GLOB).replace('*', '');
const dirs = fs.readdirSync(root).filter(n => n.startsWith(prefix) && fs.existsSync(path.join(root, n, 'trades.jsonl')));
const trades = [];
for (const d of dirs) for (const l of fs.readFileSync(path.join(root, d, 'trades.jsonl'), 'utf8').split('\n')) if (l) { const t = JSON.parse(l); if (t.ctx && t.ctx.stock) trades.push(t); }
if (!trades.length) { console.log('no trades found for', GLOB); process.exit(); }
trades.sort((a, b) => a.day.localeCompare(b.day));
const days = [...new Set(trades.map(t => t.day))].sort(), MID = days[Math.floor(days.length / 2)];

// ---- features, all signed in the trade's direction where that matters ----
const dirOf = t => (t.side === 'long' ? 1 : -1);
const FEATS = {
  trendGapPct: t => Math.abs(t.ctx.stock.ema20 - t.ctx.stock.ema50) / t.ctx.stock.close * 100,
  trendAligned: t => (t.ctx.planBias === 'neutral' ? 0 : t.ctx.planBias === (dirOf(t) === 1 ? 'bull' : 'bear') ? 1 : -1),
  rankScore: t => t.ctx.stock.score,
  atrPct: t => t.ctx.stock.atrPct,
  mom5InDir: t => t.ctx.stock.mom5 * dirOf(t),
  rsiInDir: t => (dirOf(t) === 1 ? t.ctx.stock.rsi : 100 - t.ctx.stock.rsi),
  gapInDir: t => t.ctx.gapPct * dirOf(t),
  relStrengthInDir: t => t.ctx.relStrengthPct,
  marketInDir: t => (t.ctx.niftyChgPct == null ? null : t.ctx.niftyChgPct * dirOf(t)),
  vwapDistInDir: t => t.ctx.vwapDistPct * dirOf(t),
  volRatio: t => t.ctx.volRatio,
  chasePct: t => t.ctx.chasePct,
  entryMinute: t => t.ctx.minuteOfDay,
  orRangePct: t => (t.ctx.or ? t.ctx.or.rangePct : null),
  stopPct: t => t.riskPerShare / t.entry * 100,
  vix: t => t.ctx.vix,
  turnoverCr: t => t.ctx.stock.turnover / 1e7,
  crossedBefore: t => t.ctx.crossedBefore,
  priceSlope15mInDir: t => (t.ctx.priceSlope15m == null ? null : t.ctx.priceSlope15m * dirOf(t)),
  prevDayBreak: t => (t.ctx.prevDayBreak ? 1 : 0),
  confidence: t => (t.ctx.confidence ? t.ctx.confidence.score : null),
  isLong: t => (dirOf(t) === 1 ? 1 : 0)
};
const names = Object.keys(FEATS);
const N = trades.length, X = names.map(n => Float64Array.from(trades, t => { const v = FEATS[n](t); return v == null || !isFinite(v) ? NaN : v; }));
const R = Float64Array.from(trades, t => t.rMultiple), D = trades.map(t => t.day);
const TRAIN = trades.map(t => t.day < MID);
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };

function statOf(idx, Rv = R) {
  if (idx.length < 5) return { n: idx.length, avg: NaN, t: 0, win: NaN };
  const byDay = new Map(); let sum = 0, w = 0;
  for (const i of idx) { sum += Rv[i]; if (Rv[i] > 0) w++; const d = D[i]; (byDay.get(d) || byDay.set(d, []).get(d)).push(Rv[i]); }
  const dm = [...byDay.values()].map(mean), s = sd(dm);
  return { n: idx.length, days: dm.length, avg: sum / idx.length, win: w / idx.length * 100, t: dm.length > 3 && s > 0 ? mean(dm) / (s / Math.sqrt(dm.length)) : 0, net: 0 };
}
const all = Array.from({ length: N }, (_, i) => i), trainIdx = all.filter(i => TRAIN[i]), testIdx = all.filter(i => !TRAIN[i]);
const f2 = (x, d = 2) => (x == null || !isFinite(x) ? '-' : Number(x).toFixed(d));

console.log(`${dirs.length} chunks, ${N} hypothetical trades over ${days.length} sessions (${days[0]} to ${days[days.length - 1]}); search half = before ${MID} (${trainIdx.length} trades), test half = from ${MID} (${testIdx.length}).`);
const b1 = statOf(trainIdx), b2 = statOf(testIdx), b0 = statOf(all);
console.log(`BASELINE (the live rules on every stock, no ranking): ${f2(b0.avg)}R per trade, win ${f2(b0.win, 0)}%  | first half ${f2(b1.avg)}R, second half ${f2(b2.avg)}R`);
for (const [lab, f] of [['long', i => X[names.indexOf('isLong')][i] === 1], ['short', i => X[names.indexOf('isLong')][i] === 0]]) { const s = statOf(all.filter(f)); console.log(`  ${lab}: ${s.n} trades ${f2(s.avg)}R, win ${f2(s.win, 0)}%`); }

// ---- single measurements: quintiles cut on the search half, shown for both halves ----
const cuts = names.map((_, j) => { const v = trainIdx.map(i => X[j][i]).filter(x => !isNaN(x)).sort((a, b) => a - b); return [0.2, 0.4, 0.6, 0.8].map(p => v[Math.floor(p * (v.length - 1))]); });
const bucket = (j, i) => { const v = X[j][i]; if (isNaN(v)) return -1; let b = 0; for (const c of cuts[j]) if (v > c) b++; return b; };
console.log('\nONE MEASUREMENT AT A TIME: average net R per trade by fifth (Q1 lowest ... Q5 highest), search half | test half');
console.log('measurement           Q1            Q2            Q3            Q4            Q5      | top minus bottom: search / test');
const single = [];
for (let j = 0; j < names.length; j++) {
  if (names[j] === 'isLong' || names[j] === 'trendAligned' || names[j] === 'prevDayBreak') continue;
  const cells = [], q = [[], []];
  for (let b = 0; b < 5; b++) { const a = trainIdx.filter(i => bucket(j, i) === b), c = testIdx.filter(i => bucket(j, i) === b); q[0].push(a); q[1].push(c); cells.push(`${f2(statOf(a).avg).padStart(5)}|${f2(statOf(c).avg).padStart(5)}`); }
  const d1 = statOf(q[0][4]).avg - statOf(q[0][0]).avg, d2 = statOf(q[1][4]).avg - statOf(q[1][0]).avg;
  single.push({ name: names[j], d1, d2 });
  console.log(`${names[j].padEnd(20)} ${cells.join('  ')}   | ${f2(d1).padStart(6)} / ${f2(d2).padStart(6)}${Math.sign(d1) === Math.sign(d2) && Math.abs(d1) > 0.1 && Math.abs(d2) > 0.1 ? '   <- same direction in both halves' : ''}`);
}

// ---- rule search: up to 2 conditions, thresholds at the search-half cut points ----
function conditions() { const out = []; for (let j = 0; j < names.length; j++) for (let c = 0; c < 4; c++) for (const op of ['>', '<=']) { const th = cuts[j][c]; if (th == null || isNaN(th)) continue; out.push({ j, op, th, label: `${names[j]} ${op} ${f2(th, 2)}` }); } return out; }
const conds = conditions();
const mask = c => { const m = new Uint8Array(N); const col = X[c.j]; for (let i = 0; i < N; i++) { const v = col[i]; m[i] = !isNaN(v) && (c.op === '>' ? v > c.th : v <= c.th) ? 1 : 0; } return m; };
const masks = conds.map(mask);
function search(Rv, top = 10) {
  const found = [];
  const evalRule = (m1, m2, label) => {
    let n = 0, s = 0; const byDay = new Map();
    for (const i of trainIdx) { if (m1[i] && (!m2 || m2[i])) { n++; s += Rv[i]; const d = D[i]; byDay.set(d, (byDay.get(d) || 0) + 0); } }
    if (n < MINTRAIN) return;
    const dm = new Map(); for (const i of trainIdx) if (m1[i] && (!m2 || m2[i])) { const d = D[i]; const e = dm.get(d) || [0, 0]; e[0] += Rv[i]; e[1]++; dm.set(d, e); }
    const means = [...dm.values()].map(e => e[0] / e[1]), sdv = sd(means), t = means.length > 3 && sdv > 0 ? mean(means) / (sdv / Math.sqrt(means.length)) : 0;
    found.push({ label, avg: s / n, n, t, m1, m2 });
  };
  for (let a = 0; a < conds.length; a++) { evalRule(masks[a], null, conds[a].label); for (let b = a + 1; b < conds.length; b++) if (conds[a].j !== conds[b].j) evalRule(masks[a], masks[b], conds[a].label + '  AND  ' + conds[b].label); }
  found.sort((x, y) => y.t - x.t);
  return found.slice(0, top);
}
console.log('\nRULE SEARCH on the first half only (best by day-clustered t; at least ' + MINTRAIN + ' trades), then tested on the second half:');
const best = search(R, 12);
console.log('rule'.padEnd(78) + 'search: n   R      t  |  TEST: n    R   win%  t    verdict');
for (const r of best) {
  const idx = testIdx.filter(i => r.m1[i] && (!r.m2 || r.m2[i])), s = statOf(idx);
  const verdict = s.avg > 0.05 && s.t >= 2 ? 'holds up' : s.avg > b2.avg + 0.05 ? 'better than baseline, not proven' : 'did not hold';
  console.log(r.label.padEnd(78) + `${String(r.n).padStart(6)} ${f2(r.avg).padStart(6)} ${f2(r.t, 1).padStart(5)} | ${String(s.n).padStart(6)} ${f2(s.avg).padStart(6)} ${f2(s.win, 0).padStart(4)}% ${f2(s.t, 1).padStart(4)}  ${verdict}`);
}

// ---- control: the same search on shuffled outcomes (no real relationship exists) ----
console.log(`\nCONTROL: the same search on ${SHUF} shuffles of the outcomes. This is how good a rule looks by luck alone.`);
let seed = 99; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const luckT = [], luckAvg = [], luckTest = [];
for (let k = 0; k < SHUF; k++) {
  const sh = Float64Array.from(R), ti = trainIdx.slice();
  for (let i = ti.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const a = ti[i], b = ti[j]; const tmp = sh[a]; sh[a] = sh[b]; sh[b] = tmp; }
  const top = search(sh, 1)[0]; if (!top) continue;
  luckT.push(top.t); luckAvg.push(top.avg);
  luckTest.push(statOf(testIdx.filter(i => top.m1[i] && (!top.m2 || top.m2[i]))).avg);
}
luckT.sort((a, b) => a - b);
console.log(`best search-half t by luck: median ${f2(luckT[Math.floor(luckT.length / 2)], 1)}, highest ${f2(luckT[luckT.length - 1], 1)}; best-by-luck rule's average R on the search half ${f2(mean(luckAvg))}, on the test half ${f2(mean(luckTest))} (the test number shows how little a lucky rule carries over).`);
console.log('A real rule must beat the luck level on the search half AND hold up on the test half.');
