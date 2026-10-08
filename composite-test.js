// Pre-registered test 2: a COMBINED factor score with lower turnover. Run on 18 years of NIFTY 200 daily data.
//   node --max-old-space-size=6144 composite-test.js --dir data/fyers-daily-18y
// FROZEN PROTOCOL (written before any result was seen; do not change it after looking):
//   composite  average cross-sectional percentile rank of A3, A6, A12, A33, A44 and 5-day reversal. These six were chosen
//              because their rank IC was positive with t >= 2 in the DEVELOPMENT period of the first test; nothing else.
//   timing     signal from the previous close; buy at the first session's open of each period, sell at the next period's open
//   universe   on each date the 100 most liquid stocks (20-day average turnover), 253+ sessions of history, no one-day move
//              over 35% in the window; at least 40 stocks that date, else the date is skipped
//   variants   W-FULL  weekly, top fifth equal weight, full turnover every week
//              W-BUFF  weekly, keep a holding until it falls below the top 40%, refill to a fifth from the best-ranked; cost only on replaced names
//              M-FULL  monthly, top fifth, full turnover
//   cost       0.31% per round trip (buy + sell) per position replaced
//   periods    development 2017-10 to 2022-12; holdout A 2023-01 to 2026-10; holdout B 2009-06 to 2016-09 (never looked at by any test)
//   pass       after-cost excess over the universe average is positive in ALL THREE periods AND the sign-flip p-value on holdouts
//              A + B combined is below 0.05 after adjusting for the 3 variants
// SURVIVORSHIP: the universe is today's NIFTY 200. Excess over the same universe's average removes the level of that bias
// but not all of it; the older the data, the stronger the bias, so holdout B is the most flattering period.
const fs = require('fs');
const path = require('path');
const F = require('./lib/factors');
const V = require('./lib/validate');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const dir = arg('dir', 'data/fyers-daily-18y');
const COST = 0.0031, UNIVERSE = 100, TOP = 0.2, BUFFER = 0.4, TESTS = 3;
const PERIODS = [['development', '2017-10-01', '2022-12-31'], ['holdout A', '2023-01-01', '2026-12-31'], ['holdout B', '2009-06-01', '2016-09-30']];
const MEMBERS = ['A3', 'A6', 'A12', 'A33', 'A44', 'REV5'];

// ---------- load ----------
const raw = {};
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.csv')) continue;
  raw[f.slice(0, -4)] = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').slice(1).map(l => l.split(',')).map(r => ({ d: r[0].slice(0, 10), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
}
const cal = raw.NIFTY.map(r => r.d), T = cal.length, ci = new Map(cal.map((d, i) => [d, i]));
const syms = Object.keys(raw).filter(s => s !== 'NIFTY' && s !== 'INDIAVIX');
const P = { open: [], high: [], low: [], close: [], volume: [] };
for (const s of syms) {
  const row = { open: new Array(T).fill(NaN), high: new Array(T).fill(NaN), low: new Array(T).fill(NaN), close: new Array(T).fill(NaN), volume: new Array(T).fill(NaN) };
  for (const r of raw[s]) { const t = ci.get(r.d); if (t == null || !(r.c > 0)) continue; row.open[t] = r.o; row.high[t] = r.h; row.low[t] = r.l; row.close[t] = r.c; row.volume[t] = r.v; }
  for (const k of Object.keys(P)) P[k].push(row[k]);
}
console.log(`${syms.length} stocks, ${T} sessions (${cal[0]} to ${cal[T - 1]})`);

// ---------- composite score ----------
const ranks = MEMBERS.map(m => F.csRank(F.FACTORS[m].f(P)));
const C = P.close.map((_, i) => P.close[i].map((__, t) => { let s = 0; for (const r of ranks) { const v = r[i][t]; if (!Number.isFinite(v)) return NaN; s += v; } return s / ranks.length; }));

// ---------- dates ----------
const wk = d => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); return t.getUTCFullYear() * 100 + Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7); };
const startsOf = key => { const o = []; for (let t = 1; t < T; t++) if (key(cal[t]) !== key(cal[t - 1])) o.push(t); return o; };

function buildPeriods(starts) {
  const out = [];
  for (let w = 0; w + 1 < starts.length; w++) {
    const x = starts[w], xe = starts[w + 1];
    if (x < 262) continue;
    const cand = [];
    for (let i = 0; i < syms.length; i++) {
      const o0 = P.open[i][x], o1 = P.open[i][xe];
      if (!(o0 > 0) || !(o1 > 0) || !Number.isFinite(P.close[i][x - 1]) || !Number.isFinite(P.close[i][x - 253]) || !Number.isFinite(C[i][x - 1])) continue;
      let turn = 0, ok = true;
      for (let t = x - 20; t < x; t++) { const c = P.close[i][t], v = P.volume[i][t]; if (!Number.isFinite(c) || !Number.isFinite(v)) { ok = false; break; } turn += c * v; }
      if (!ok) continue;
      let art = false; for (let t = x - 252; t <= xe && !art; t++) { const a = P.close[i][t], b = P.close[i][t - 1]; if (a > 0 && b > 0 && Math.abs(a / b - 1) > 0.35) art = true; }
      if (art) continue;
      cand.push({ i, turn, fr: o1 / o0 - 1, score: C[i][x - 1] });
    }
    cand.sort((a, b) => b.turn - a.turn);
    const el = cand.slice(0, UNIVERSE);
    if (el.length >= 40) out.push({ day: cal[x], el });
  }
  return out;
}

// ---------- run a variant ----------
function run(periods, buffered) {
  const rows = []; let held = new Set(), turnSum = 0;
  for (const p of periods) {
    const el = p.el, N = el.length, size = Math.max(1, Math.ceil(N * TOP));
    const byScore = el.slice().sort((a, b) => b.score - a.score);
    const rank = new Map(byScore.map((e, k) => [e.i, k]));
    const uni = V.mean(el.map(e => e.fr));
    let keep = new Set();
    if (buffered) for (const i of held) { const k = rank.get(i); if (k != null && k < Math.ceil(N * BUFFER)) keep.add(i); }
    const picks = new Set(keep);
    for (const e of byScore) { if (picks.size >= size) break; picks.add(e.i); }
    const replaced = [...picks].filter(i => !held.has(i)).length;
    const turnover = held.size ? replaced / picks.size : 1;
    const frOf = new Map(el.map(e => [e.i, e.fr]));
    const ret = V.mean([...picks].map(i => frOf.get(i)));
    rows.push({ day: p.day, ex: ret - uni, exNet: ret - uni - COST * turnover, turnover });
    turnSum += turnover; held = picks;
  }
  return { rows, avgTurnover: turnSum / (rows.length || 1) };
}

const weekly = buildPeriods(startsOf(wk)), monthly = buildPeriods(startsOf(d => d.slice(0, 7)));
console.log(`${weekly.length} weekly and ${monthly.length} monthly periods (${weekly[0].day} to ${weekly[weekly.length - 1].day}); stocks per period: ${Math.round(weekly.reduce((a, w) => a + w.el.length, 0) / weekly.length)}\n`);

const f2 = (v, d = 2) => (v == null || !isFinite(v) ? '-' : v.toFixed(d));
const inP = (rows, a, b) => rows.filter(r => r.day >= a && r.day <= b);
const variants = [['W-FULL', run(weekly, false), 52], ['W-BUFF', run(weekly, true), 52], ['M-FULL', run(monthly, false), 12]];
const verdicts = [];
for (const [name, res, ppy] of variants) {
  console.log(`${name}   average share of the portfolio replaced each period: ${f2(res.avgTurnover * 100, 0)}%`);
  console.log('   period        periods   gross excess/period   after-cost excess/period   per year (after cost)   95% range per period');
  const pos = [];
  for (const [label, a, b] of PERIODS) {
    const part = inP(res.rows, a, b);
    if (!part.length) { console.log(`   ${label.padEnd(12)}  no data`); pos.push(false); continue; }
    const bs = V.clusterBootstrap(part.map(r => r.exNet), part.map(r => r.day), { n: 3000 });
    console.log(`   ${label.padEnd(12)} ${String(part.length).padStart(7)}   ${(f2(V.mean(part.map(r => r.ex)) * 100, 3) + '%').padStart(16)}   ${(f2(V.mean(part.map(r => r.exNet)) * 100, 3) + '%').padStart(22)}   ${(f2(V.mean(part.map(r => r.exNet)) * ppy * 100, 1) + '%').padStart(18)}   ${f2(bs.meanLo * 100, 3)}% to ${f2(bs.meanHi * 100, 3)}%`);
    pos.push(V.mean(part.map(r => r.exNet)) > 0);
  }
  const ho = [...inP(res.rows, PERIODS[1][1], PERIODS[1][2]), ...inP(res.rows, PERIODS[2][1], PERIODS[2][2])];
  const sf = V.signFlipTest(ho.map(r => r.exNet), ho.map(r => r.day));
  const adj = V.sidak(sf.p, TESTS), pass = pos.every(Boolean) && adj < 0.05;
  console.log(`   holdouts A+B combined: sign-flip p = ${f2(sf.p, 4)}, adjusted for ${TESTS} variants = ${f2(adj, 4)}   ->   ${pass ? 'PASSES the frozen rule' : 'does not pass'}\n`);
  verdicts.push([name, pass]);
}
console.log(`Result: ${verdicts.filter(v => v[1]).length} of ${verdicts.length} variants pass (${verdicts.map(v => v[0] + (v[1] ? ' yes' : ' no')).join(', ')}).`);
