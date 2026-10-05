// What predicts a stock's move from mid-morning to 15:15?  A clean screen before any entry rules are built.
//   node factors.js            (Yahoo 5-minute history, about 56 sessions, cached in data/lab-cache by lab.js)
// For each decision time (10:00, 10:30, 11:30, 12:30, 13:30) and each measurement, stocks are ranked WITHIN each day
// (so the market's direction cancels out), and we compare the top fifth with the bottom fifth:
//   pair = (average forward return of the top fifth - average forward return of the bottom fifth) / 2 - one round-trip cost
// i.e. a dollar-neutral long/short basket, held from the decision bar's close to 15:15, no stops.
// Statistics are CLUSTERED BY DAY (one number per session, t-test across sessions), because stocks on the same day
// move together and treating them as independent would overstate every result.
// Round-trip cost 0.14% of the traded value (charges about 0.10% plus slippage 0.04%), paid on each leg.
// Controls: four random-noise "measurements" show how big a t-statistic looks when there is no signal at all.
// A measurement is only interesting if: net pair return > 0, t >= 3, the same sign in both halves, and it beats the best control.
const fs = require('fs');
const path = require('path');
const base = require('./config');
const { yf } = require('./lib/data');
const { analyzeDaily } = require('./lib/planner');
const { dayKey, minOfDay } = require('./lib/time');

const CACHE = path.join(__dirname, 'data', 'lab-cache');
const OPEN = 555, COST = 0.14;
const TIMES = [[8, '10:00'], [14, '10:30'], [26, '11:30'], [38, '12:30'], [50, '13:30']];
const EXIT_K = 72; // bar starting 15:15
const argv = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const QF = +argv('q', 0.2);                       // fraction of the day's stocks in each tail: 0.2 = fifths, 0.1 = tenths, 0.05 = twentieths
const ONLYF = argv('only', null) ? argv('only', '').split(',') : null;

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function cached(name, fetcher) {
  fs.mkdirSync(CACHE, { recursive: true });
  const f = path.join(CACHE, name.replace(/[^A-Za-z0-9_.-]/g, '_') + '.json');
  if (fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < 12 * 3600e3) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const data = await fetcher();
  fs.writeFileSync(f, JSON.stringify(data));
  return data;
}
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
const tstat = a => (a.length > 3 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : 0);
let seed = 12345; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

(async () => {
  const syms = base.watchlist.slice();
  const five = {}, daily = {};
  let i = 0;
  const worker = async () => { while (i < syms.length + 1) { const s = i === 0 ? base.indexSymbol : syms[i - 1]; i++; try { five[s] = await cached('5m-' + s, () => yf(s, '5m', '60d', 3)); if (s !== base.indexSymbol) daily[s] = await cached('1d-' + s, () => yf(s, '1d', '1y', 3)); } catch (e) { /* skipped */ } await sleep(40); } };
  await Promise.all([worker(), worker(), worker(), worker()]);

  const nb = five[base.indexSymbol], nDays = {};
  for (const b of nb) (nDays[dayKey(b.t)] = nDays[dayKey(b.t)] || []).push(b);
  const sessions = Object.keys(nDays).filter(k => nDays[k].length >= 74).sort();
  const maxPrice = base.capital * base.leverage * (base.maxAllocPct / 100);

  // ---- build every stock-day ----
  const rows = []; // { day, k-features... }
  const profileSum = new Array(75).fill(0); let profileN = 0;
  const stockDays = [];
  for (const day of sessions) {
    const nO = [], nC = [], nUp = []; let nsum = 0;
    for (const b of nDays[day]) { const k = (minOfDay(b.t) - OPEN) / 5; if (Number.isInteger(k) && k >= 0 && k < 75) { nO[k] = b.o; nC[k] = b.c; nsum += (b.h + b.l + b.c) / 3; nUp[k] = b.c > nsum / (k + 1); } }
    if (nO[EXIT_K] === undefined) continue;
    for (const s of syms) {
      if (!five[s] || !daily[s]) continue;
      const bars = five[s].filter(b => dayKey(b.t) === day);
      if (bars.length < 72) continue;
      const hist = daily[s].filter(c => dayKey(c.t) < day);
      const info = analyzeDaily(s, hist);
      if (!info || info.atrPct < base.minAtrPct || info.atrPct > base.maxAtrPct || info.turnover < base.minTurnover || info.close > maxPrice) continue;
      const o = [], h = [], l = [], c = [], v = [];
      for (const b of bars) { const k = (minOfDay(b.t) - OPEN) / 5; if (Number.isInteger(k) && k >= 0 && k < 75) { o[k] = b.o; h[k] = b.h; l[k] = b.l; c[k] = b.c; v[k] = b.v; } }
      let ok = o[EXIT_K] !== undefined; for (let k = 0; k < 72 && ok; k++) if (c[k] === undefined) ok = false;
      if (!ok) continue;
      const cum = [], vw = []; let cv = 0, pv = 0, sm = 0;
      for (let k = 0; k < 75; k++) { if (c[k] === undefined) break; const tp = (h[k] + l[k] + c[k]) / 3; cv += v[k]; pv += tp * v[k]; sm += tp; cum[k] = cv; vw[k] = cv > 0 ? pv / cv : sm / (k + 1); }
      const total = cum[Math.min(74, cum.length - 1)] || 1;
      for (let k = 0; k < cum.length; k++) profileSum[k] += cum[k] / total; profileN++;
      const last20 = hist.slice(-20), avgVol = mean(last20.map(x => x.v)), prevClose = hist[hist.length - 1].c, prev2 = hist[hist.length - 2].c;
      stockDays.push({ day, s, o, h, l, c, v, cum, vw, avgVol, prevClose, prev2, atr: info.atrPct, nO, nC });
    }
  }
  const profile = profileSum.map(x => x / profileN);
  console.log(`${sessions.length} sessions, ${stockDays.length} eligible stock-days (${(stockDays.length / sessions.length).toFixed(0)} per day)\n`);

  // ---- measurements at each decision time ----
  const FEATURES = ['rs', 'pct', 'gap', 'dvwap', 'rangePos', 'mom30', 'mom60', 'rvolCum', 'prevRet', 'rsAtr', 'orPos', 'fromHigh', 'fromLow', 'rand1', 'rand2', 'rand3', 'rand4'];
  const results = {}; // key -> { days: {day: [ {f, r, ra} ]} }
  for (const sd_ of stockDays) {
    const { day, o, h, l, c, cum, vw } = sd_;
    for (const [k, label] of TIMES) {
      const px = c[k], exit = o[EXIT_K];
      const fwd = (exit / px - 1) * 100, nfwd = (sd_.nO[EXIT_K] / sd_.nC[k] - 1) * 100;
      const dayHi = Math.max(...h.slice(0, k + 1)), dayLo = Math.min(...l.slice(0, k + 1));
      const orH = Math.max(h[0], h[1], h[2]), orL = Math.min(l[0], l[1], l[2]);
      const pct = (px / o[0] - 1) * 100, npct = (sd_.nC[k] / sd_.nO[0] - 1) * 100;
      const F = {
        rs: pct - npct, pct, gap: (o[0] / sd_.prevClose - 1) * 100, dvwap: (px - vw[k]) / vw[k] * 100,
        rangePos: (px - dayLo) / (dayHi - dayLo || 1), mom30: (px / c[k - 6] - 1) * 100, mom60: (px / c[k - 12 >= 0 ? k - 12 : 0] - 1) * 100,
        rvolCum: cum[k] / ((sd_.avgVol * profile[k]) || 1), prevRet: (sd_.prevClose / sd_.prev2 - 1) * 100, rsAtr: (pct - npct) / sd_.atr,
        orPos: (px - orL) / (orH - orL || 1), fromHigh: (dayHi - px) / px * 100, fromLow: (px - dayLo) / px * 100,
        rand1: rnd(), rand2: rnd(), rand3: rnd(), rand4: rnd()
      };
      for (const name of FEATURES) {
        const key = name + '|' + label;
        const R = results[key] || (results[key] = {});
        (R[day] = R[day] || []).push({ f: F[name], r: fwd, ra: fwd - nfwd });
      }
    }
  }

  // ---- per-day dollar-neutral top-fifth vs bottom-fifth pair ----
  // gross = (average forward return of the top fifth - that of the bottom fifth) / 2, per session, before costs.
  // Significance is judged on the gross numbers; costs are subtracted afterwards from whichever direction is better.
  const mid = sessions[Math.floor(sessions.length / 2)];
  const out = [];
  for (const [key, byDay] of Object.entries(results)) {
    const [name, label] = key.split('|');
    const gross = [], first = [], second = [];
    for (const day of Object.keys(byDay).sort()) {
      const arr = byDay[day]; if (arr.length < 30) continue;
      arr.sort((x, y) => x.f - y.f);
      const q = Math.max(3, Math.floor(arr.length * QF)), lo = arr.slice(0, q), hi = arr.slice(arr.length - q);
      const g = (mean(hi.map(x => x.r)) - mean(lo.map(x => x.r))) / 2;
      gross.push(g); (day < mid ? first : second).push(g);
    }
    const m = mean(gross), dir = m >= 0 ? 'top-long/bottom-short' : 'top-short/bottom-long';
    const sign = m >= 0 ? 1 : -1;
    out.push({ name, label, n: gross.length, dir, gross: sign * m, t: sign * tstat(gross), net: sign * m - COST, m1: sign * mean(first), m2: sign * mean(second), n1: first.length, n2: second.length });
  }

  const f3 = (x, d = 3) => Number(x).toFixed(d);
  const controls = out.filter(r => r.name.startsWith('rand')), real = out.filter(r => !r.name.startsWith('rand') && (!ONLYF || ONLYF.includes(r.name)));
  console.log(`Tail size: top and bottom ${QF * 100}% of each day${ONLYF ? ', only ' + ONLYF.join(', ') : ''}`);
  const bestCtl = Math.max(...controls.map(r => r.t));
  console.log(`CONTROLS: ${controls.length} random-number measurements; the best |t| by pure luck was ${f3(bestCtl, 1)}.`);
  console.log(`REAL: ${real.length} tests (13 measurements x 5 times). With this many tests, a few |t| above 2 are expected by luck alone.\n`);
  console.log('Per session, % of the traded value per leg. "dir" is the better direction for that measurement. gross = before costs, net = after the 0.14% round-trip cost.');
  console.log('measurement  time  direction               gross%   t   net%  | gross 1st half / 2nd half | sessions | verdict');
  real.sort((x, y) => y.t - x.t);
  const verdict = r => (r.t >= 3 && r.net > 0 && r.m1 > 0 && r.m2 > 0 && r.t > bestCtl ? 'PASSES' : r.t >= 2 && r.m1 > 0 && r.m2 > 0 ? (r.net > 0 ? 'promising, not proven' : 'real but smaller than costs') : r.t >= 2 ? 'not consistent across halves' : 'no signal');
  for (const r of real.slice(0, 16)) console.log(`${r.name.padEnd(11)} ${r.label}  ${r.dir.padEnd(22)} ${f3(r.gross).padStart(7)} ${f3(r.t, 1).padStart(5)} ${f3(r.net).padStart(7)} | ${f3(r.m1).padStart(7)} / ${f3(r.m2).padStart(7)} | ${r.n1}+${r.n2} | ${verdict(r)}`);
  const passes = real.filter(r => verdict(r) === 'PASSES');
  const promising = real.filter(r => verdict(r) === 'promising, not proven');
  console.log(`\nPASSES: ${passes.length}   promising: ${promising.length}   (a PASS needs: |t| >= 3, net of costs > 0, positive in both halves, beats every random control)`);
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'data', 'factor-results.json'), JSON.stringify({ sessions, out }));
})().catch(e => { console.error('FACTORS ERROR', e.stack); process.exit(1); });
