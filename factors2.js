// Same question as factors.js (what predicts a stock's move from mid-morning to 15:15?) on the long Fyers history.
//   node --max-old-space-size=6000 factors2.js --dir data/fyers-5m [--q 0.05] [--max 40] [--only prevRet,dvwap]
// Pre-registered (fixed before looking): 13 measurements x 5 decision times, top vs bottom tail of each day's stocks,
// held from the decision bar's close to 15:15 with no stops, dollar-neutral long/short, 0.14% round-trip cost per leg.
// Statistics are clustered by day. Stability is checked quarter by quarter (24 months = 8 quarters) and against 4 random controls.
// PASS = |t| >= 3.5, net of cost > 0, positive in at least 6 of the 8 quarters, and beats every random control.
const fs = require('fs');
const path = require('path');
const base = require('./config');
const { analyzeDaily } = require('./lib/planner');
const { dayKey, minOfDay } = require('./lib/time');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const DIR = arg('dir', 'data/fyers-5m'), QF = +arg('q', 0.05), MAXSYM = +arg('max', 1e9);
const ONLYF = arg('only', null) ? arg('only', '').split(',') : null;
const OPEN = 555, EXIT_K = 72, COST = 0.14, WARM = 60;
const TIMES = [[8, '10:00'], [14, '10:30'], [26, '11:30'], [38, '12:30'], [50, '13:30']];
const FEATURES = ['rs', 'pct', 'gap', 'dvwap', 'rangePos', 'mom30', 'mom60', 'rvolCum', 'prevRet', 'rsAtr', 'orPos', 'fromHigh', 'fromLow'];
const NF = FEATURES.length, NT = TIMES.length;
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
const tstat = a => (a.length > 3 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : 0);
let seed = 987654; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

function readCsv(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const days = new Map();
  for (let i = 1; i < lines.length; i++) {
    const r = lines[i].split(','); if (r.length < 6) continue;
    const t = Date.parse(r[0]); const k = (minOfDay(t) - OPEN) / 5;
    if (!(k >= 0 && k < 75) || !Number.isInteger(k)) continue;
    const dk = dayKey(t);
    let d = days.get(dk); if (!d) { d = { o: new Float64Array(75).fill(NaN), h: new Float64Array(75).fill(NaN), l: new Float64Array(75).fill(NaN), c: new Float64Array(75).fill(NaN), v: new Float64Array(75) }; days.set(dk, d); }
    d.o[k] = +r[1]; d.h[k] = +r[2]; d.l[k] = +r[3]; d.c[k] = +r[4]; d.v[k] = +r[5];
  }
  return days;
}
const complete = d => { for (let k = 0; k < 72; k++) if (!(d.c[k] > 0)) return false; return d.o[EXIT_K] > 0; };

(async () => {
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.csv'));
  if (!files.includes('NIFTY.csv')) throw new Error('NIFTY.csv not found in ' + DIR);
  const nifty = readCsv(path.join(DIR, 'NIFTY.csv'));
  const N = new Map();
  for (const [dk, d] of nifty) {
    if (!complete(d)) continue;
    const up = new Array(75).fill(false); let s = 0;
    for (let k = 0; k < 75 && d.c[k] > 0; k++) { s += (d.h[k] + d.l[k] + d.c[k]) / 3; up[k] = d.c[k] > s / (k + 1); }
    N.set(dk, { o: d.o, c: d.c, up });
  }
  const sessions = [...N.keys()].sort();
  console.log(`Nifty: ${sessions.length} complete sessions, ${sessions[0]} to ${sessions[sessions.length - 1]}`);
  const maxPrice = base.capital * base.leverage * (base.maxAllocPct / 100);

  const rows = []; // { day, F: Float32Array(NF*NT), R: Float32Array(NT), NR: Float32Array(NT) }
  let nSym = 0;
  for (const f of files) {
    const sym = f.slice(0, -4);
    if (sym === 'NIFTY' || sym === 'INDIAVIX') continue;
    if (nSym >= MAXSYM) break;
    nSym++;
    const days = readCsv(path.join(DIR, f));
    const keys = [...days.keys()].filter(k => N.has(k)).sort();
    const dailyList = [], cumFracs = [];
    for (let di = 0; di < keys.length; di++) {
      const day = keys[di], d = days.get(day);
      if (!complete(d)) { continue; }
      let total = 0; for (let k = 0; k < 75; k++) total += d.v[k] || 0;
      const cum = new Float64Array(75); let cv = 0; for (let k = 0; k < 75; k++) { cv += d.v[k] || 0; cum[k] = cv; }
      const cf = new Float32Array(75); for (let k = 0; k < 75; k++) cf[k] = total > 0 ? cum[k] / total : 0;
      let hi = -Infinity, lo = Infinity; for (let k = 0; k < 75; k++) if (d.c[k] > 0) { if (d.h[k] > hi) hi = d.h[k]; if (d.l[k] < lo) lo = d.l[k]; }
      const hist = dailyList.slice(), hfr = cumFracs.slice(-20);
      dailyList.push({ t: Date.parse(day + 'T05:00:00Z'), o: d.o[0], h: hi, l: lo, c: d.c[71 + (d.c[72] > 0 ? 1 : 0)] || d.c[71], v: total });
      cumFracs.push(cf);
      if (hist.length < WARM || hfr.length < 10) continue;
      const info = analyzeDaily(sym, hist);
      if (!info || info.atrPct < base.minAtrPct || info.atrPct > base.maxAtrPct || info.turnover < base.minTurnover || info.close > maxPrice) continue;
      const last20 = hist.slice(-20), avgVol = mean(last20.map(x => x.v)), prevClose = hist[hist.length - 1].c, prev2 = hist[hist.length - 2].c;
      const nd = N.get(day), exit = d.o[EXIT_K];
      const F = new Float32Array(NF * NT), R = new Float32Array(NT), NR = new Float32Array(NT);
      const vw = new Float64Array(75); { let pv = 0, vv = 0, sm = 0; for (let k = 0; k < 75; k++) { if (!(d.c[k] > 0)) break; const tp = (d.h[k] + d.l[k] + d.c[k]) / 3; pv += tp * d.v[k]; vv += d.v[k]; sm += tp; vw[k] = vv > 0 ? pv / vv : sm / (k + 1); } }
      for (let ti = 0; ti < NT; ti++) {
        const k = TIMES[ti][0], px = d.c[k];
        let dayHi = -Infinity, dayLo = Infinity; for (let q = 0; q <= k; q++) { if (d.h[q] > dayHi) dayHi = d.h[q]; if (d.l[q] < dayLo) dayLo = d.l[q]; }
        const orH = Math.max(d.h[0], d.h[1], d.h[2]), orL = Math.min(d.l[0], d.l[1], d.l[2]);
        const pct = (px / d.o[0] - 1) * 100, npct = (nd.c[k] / nd.o[0] - 1) * 100;
        const prof = mean(hfr.map(x => x[k]));
        const vals = [pct - npct, pct, (d.o[0] / prevClose - 1) * 100, (px - vw[k]) / vw[k] * 100, (px - dayLo) / (dayHi - dayLo || 1), (px / d.c[k - 6] - 1) * 100, (px / d.c[Math.max(0, k - 12)] - 1) * 100,
          (cum[k]) / ((avgVol * prof) || 1), (prevClose / prev2 - 1) * 100, (pct - npct) / info.atrPct, (px - orL) / (orH - orL || 1), (dayHi - px) / px * 100, (px - dayLo) / px * 100];
        for (let j = 0; j < NF; j++) F[ti * NF + j] = vals[j];
        R[ti] = (exit / px - 1) * 100; NR[ti] = (nd.o[EXIT_K] / nd.c[k] - 1) * 100;
      }
      rows.push({ day, F, R });
    }
    if (nSym % 20 === 0) process.stdout.write(`  processed ${nSym} stocks, ${rows.length} stock-days\r`);
  }
  console.log(`\n${nSym} stocks, ${rows.length} eligible stock-days over ${new Set(rows.map(r => r.day)).size} sessions\n`);

  // ---- statistics ----
  const allDays = [...new Set(rows.map(r => r.day))].sort();
  const quarterOf = new Map(allDays.map((d, i) => [d, Math.min(7, Math.floor(i * 8 / allDays.length))]));
  const byDay = new Map(); for (const r of rows) { if (!byDay.has(r.day)) byDay.set(r.day, []); byDay.get(r.day).push(r); }
  const out = [];
  const names = [...FEATURES, 'rand1', 'rand2', 'rand3', 'rand4'];
  for (let ti = 0; ti < NT; ti++) {
    for (let j = 0; j < names.length; j++) {
      const gross = [], quarters = Array.from({ length: 8 }, () => []);
      for (const day of allDays) {
        const arr = byDay.get(day); if (arr.length < 30) continue;
        const items = arr.map(r => ({ f: j < NF ? r.F[ti * NF + j] : rnd(), r: r.R[ti] }));
        items.sort((a, b) => a.f - b.f);
        const q = Math.max(3, Math.floor(items.length * QF)), lo = items.slice(0, q), hi = items.slice(items.length - q);
        const g = (mean(hi.map(x => x.r)) - mean(lo.map(x => x.r))) / 2;
        gross.push(g); quarters[quarterOf.get(day)].push(g);
      }
      const m = mean(gross), sign = m >= 0 ? 1 : -1;
      out.push({ name: names[j], label: TIMES[ti][1], dir: sign === 1 ? 'top-long/bottom-short' : 'top-short/bottom-long', gross: sign * m, t: sign * tstat(gross), net: sign * m - COST, qpos: quarters.filter(q => q.length && sign * mean(q) > 0).length, qnet: quarters.filter(q => q.length && sign * mean(q) - COST > 0).length, n: gross.length });
    }
  }
  const f3 = (x, d = 3) => Number(x).toFixed(d);
  const controls = out.filter(r => r.name.startsWith('rand')), real = out.filter(r => !r.name.startsWith('rand') && (!ONLYF || ONLYF.includes(r.name)));
  const bestCtl = Math.max(...controls.map(r => r.t));
  console.log(`Tail: top and bottom ${QF * 100}% of each day. Controls (20 random-number tests): best t by luck = ${f3(bestCtl, 1)}. Real tests shown: ${real.length}.`);
  console.log('measurement  time  direction               gross%    t    net%   quarters(gross>0 / net>0 of 8) | sessions | verdict');
  const verdict = r => (r.t >= 3.5 && r.net > 0 && r.qpos >= 6 && r.t > bestCtl ? 'PASSES' : r.t >= 2.5 && r.qpos >= 6 ? (r.net > 0 ? 'promising' : 'real but smaller than costs') : r.t >= 2.5 ? 'inconsistent over time' : 'no signal');
  real.sort((a, b) => b.t - a.t);
  for (const r of real.slice(0, 18)) console.log(`${r.name.padEnd(11)} ${r.label}  ${r.dir.padEnd(22)} ${f3(r.gross).padStart(7)} ${f3(r.t, 1).padStart(6)} ${f3(r.net).padStart(7)}   ${r.qpos} / ${r.qnet}                         | ${r.n} | ${verdict(r)}`);
  const passes = real.filter(r => verdict(r) === 'PASSES');
  console.log(`\nPASSES: ${passes.length}. (Needs |t| >= 3.5, net > 0, gross positive in 6+ of 8 quarters, beats every random control.)`);
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'data', `factor2-q${QF}.json`), JSON.stringify({ allDays, out }));
})().catch(e => { console.error('FACTORS2 ERROR', e.stack); process.exit(1); });
