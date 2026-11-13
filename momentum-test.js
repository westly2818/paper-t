// Pre-registered test 3: LOW-TURNOVER 12-1 MOMENTUM on 18 years of NIFTY 200 daily data.   node --max-old-space-size=6144 momentum-test.js
// FROZEN PROTOCOL, written and committed on 13 Nov 2026 before this script was ever run. Do not change it after looking.
// Why this one: factor-test.js (8 Oct) found 12-1 momentum's rank IC positive but traded it WEEKLY at 0.31% a week, which costs more than any
// factor earns. Momentum is a months-long effect, so the same signal held monthly or quarterly pays a fraction of the cost. Nothing else is new.
//   score      12-1 momentum (MOM12_1 in lib/factors.js), cross-sectional rank on the close before the rebalance day
//   timing     buy at the open of the first session of each period, sell at the open of the next period's first session
//   universe   identical to composite-test.js: the 100 most liquid stocks of today's NIFTY 200 that day, 253+ sessions of history, no
//              one-day move over 35% in the window, at least 40 stocks
//   variants   M-BUFF  monthly, top fifth equal weight, keep a holding while it stays in the top 40%, refill from the best-ranked
//              Q-FULL  quarterly, top fifth equal weight, full turnover
//   cost       0.31% per round trip per replaced position (charges, spread and slippage, as in the earlier tests)
//   periods    development 2017-10 to 2022-12; holdout A 2023-01 to 2026-12; holdout B 2009-06 to 2016-09
//   pass       after-cost excess over the same universe's equal-weight average is positive in ALL THREE periods AND the sign-flip p-value
//              on holdouts A + B combined is below 0.05 after adjusting for the 2 variants. Nothing else counts as a pass.
// REUSE AND BIAS, stated before the run: development and holdout A were seen by the weekly momentum test (rank IC only); holdout B has never
// been used for momentum. The universe is today's NIFTY 200 (survivorship): excess over the same universe removes the level of the bias but
// momentum may still be flattered, most of all in holdout B. A pass therefore means "worth a forward test", not "proven".
const fs = require('fs');
const path = require('path');
const F = require('./lib/factors');
const V = require('./lib/validate');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const dir = arg('dir', 'data/fyers-daily-18y');
const COST = 0.0031, UNIVERSE = 100, TOP = 0.2, BUFFER = 0.4, TESTS = 2;
const PERIODS = [['development', '2017-10-01', '2022-12-31'], ['holdout A', '2023-01-01', '2026-12-31'], ['holdout B', '2009-06-01', '2016-09-30']];
const MEMBERS = ['MOM12_1'];

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

// ---------- score: 12-1 momentum (return from 12 months ago to 1 month ago), as a cross-sectional rank ----------
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

const monthly = buildPeriods(startsOf(d => d.slice(0, 7)));
const quarterly = buildPeriods(startsOf(d => d.slice(0, 4) + 'Q' + Math.floor((+d.slice(5, 7) - 1) / 3)));
console.log(`${monthly.length} monthly and ${quarterly.length} quarterly periods (${monthly[0].day} to ${monthly[monthly.length - 1].day})`);

const f2 = (v, d = 2) => (v == null || !isFinite(v) ? '-' : v.toFixed(d));
const inP = (rows, a, b) => rows.filter(r => r.day >= a && r.day <= b);
const variants = [['M-BUFF', run(monthly, true), 12], ['Q-FULL', run(quarterly, false), 4]];
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
