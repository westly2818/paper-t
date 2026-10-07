// "Momentum V5" lab: three separate intraday setups plus a 0-100 live momentum score, tested on 5-minute history.
//   node --max-old-space-size=6000 intraday-lab.js --dir data/fyers-5m-long [--dir data/fyers-5m]
//
//   A  Opening momentum   signal on a closed 5-min bar 09:35-10:30: close beyond the 09:15-09:30 range, right side of VWAP. Stop: opening-range midpoint.
//   B  Pullback continuation 10:30-13:30: stock already 1%+ from its open on the right side of VWAP, pulls back to the 9-bar average with lighter
//      volume, then a bar closes back in the trend direction through the previous bar's extreme. Stop: pullback extreme.
//   C  Afternoon consolidation breakout 13:30-14:45: 1%+ morning move, then the last 10 bars sit in a range under 0.8%, a bar closes beyond it on 1.3x volume.
//      Stop: other side of the consolidation.
// Every stop is clamped to 0.4%-1.2% of price; target 1.5R; everything left is closed at 15:15. Entry is the NEXT bar's open after the signal bar closes.
// If one bar touches both stop and target the stop is assumed hit first. Charges are 0.14% of the price per round trip, taken out of R.
// The score (25 relative strength vs Nifty, 20 volume vs the stock's own usual, 20 trend, 15 VWAP, 10 market, 10 position in the recent range) is stored for
// every trade, so the same run shows results for score cut-offs 0, 50, 60, 70, 80. NOTHING is tuned here: all numbers above were fixed before the first run.
// Development = up to 2022-12-31, holdout = 2023 onward. One trade per stock per day per setup, no portfolio limits (a live book would trade fewer of them).
const fs = require('fs');
const path = require('path');
const base = require('./config');
const { sessionsOf } = require('./lib/movers');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const FROM = arg('from', '0000-00-00'), DIR = arg('dir', 'data/fyers-5m-long'), SPLIT = '2022-12-31', COST = 0.14, RR = 1.5, MINSTOP = 0.4, MAXSTOP = 1.2;
const clamp01 = x => Math.max(0, Math.min(1, x));
const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);

function readBars(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n'), out = [];
  for (let i = 1; i < lines.length; i++) { const r = lines[i].split(','); if (r.length < 6) continue; out.push({ t: Date.parse(r[0]), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }); }
  return out;
}

const nifty = sessionsOf(readBars(path.join(DIR, 'NIFTY.csv')));
const niftyDays = [...nifty.keys()].sort();
const niftyPrev = new Map(); niftyDays.forEach((d, i) => { if (i) { const a = nifty.get(niftyDays[i - 1]); for (let k = 74; k >= 0; k--) if (a[k]) { niftyPrev.set(d, a[k].c); break; } } });

// run one trade forward from signal bar k; returns { r (net R), gross% , stopPct, exitK, why }
function runTrade(a, k, dir, rawStop) {
  const e = a[k + 1]; if (!e) return null;
  const entry = e.o;
  let stopPct = Math.abs(entry - rawStop) / entry * 100;
  if (dir === 1 ? rawStop >= entry : rawStop <= entry) stopPct = MAXSTOP;       // stop on the wrong side: use the widest allowed
  stopPct = Math.max(MINSTOP, Math.min(MAXSTOP, stopPct));
  const stop = entry * (1 - dir * stopPct / 100), target = entry * (1 + dir * RR * stopPct / 100);
  for (let j = k + 1; j < 72; j++) {
    const b = a[j]; if (!b) continue;
    if (dir === 1 ? b.l <= stop : b.h >= stop) return fin(-stopPct, stopPct, j, 'stop');
    if (dir === 1 ? b.h >= target : b.l <= target) return fin(RR * stopPct, stopPct, j, 'target');
  }
  const x = a[72] ? a[72].o : null; if (x == null) return null;
  return fin(dir * (x / entry - 1) * 100, stopPct, 72, 'time');
}
function fin(grossPct, stopPct, exitK, why) { return { r: (grossPct - COST) / stopPct, gross: grossPct, stopPct, exitK, why }; }

const rows = [];   // every trade: { s, day, y, sym, dir, score, r, stopPct, why }

function scoreAt(ctx, k, dir, rangePos) {
  const { a, nd, np, vw, cumV, avgCum, e9, e21, prev, nOpen } = ctx;
  const c = a[k].c, chg = (c / prev - 1) * 100, nc = nd[k] ? nd[k].c : null, nchg = nc && np ? (nc / np - 1) * 100 : 0;
  const rs = 25 * clamp01(dir * (chg - nchg) / 1.5);
  const rv = avgCum[k] > 0 ? cumV[k] / avgCum[k] : 1;
  const vol = 20 * clamp01((rv - 0.8) / 1.2);
  const trend = 20 * clamp01(dir * (e9[k] - e21[k]) / c / 0.003);
  const vwap = 15 * clamp01(dir * (c - vw[k]) / c / 0.003);
  const mkt = nc && nOpen ? 10 * clamp01(dir * (nc / nOpen - 1) * 100 / 0.3) : 0;
  const pos = 10 * clamp01(((dir === 1 ? rangePos : 1 - rangePos) - 0.5) / 0.4);
  return rs + vol + trend + vwap + mkt + pos;
}

function processStock(sym, bars) {
  const sess = sessionsOf(bars), days = [...sess.keys()].sort();
  const history = [];   // cumulative-volume arrays of earlier sessions
  let prevClose = null;
  for (const day of days) {
    const a = sess.get(day);
    const present = a.filter(Boolean).length;
    if (present < 70 || !a[0] || !a[3]) { history.push(null); for (let k = 74; k >= 0; k--) if (a[k]) { prevClose = a[k].c; break; } continue; }
    const cumV = new Array(75), vw = new Array(75), e9 = new Array(75), e21 = new Array(75);
    let cv = 0, pv = 0, vv = 0, x9 = a[0].c, x21 = a[0].c;
    for (let k = 0; k < 75; k++) {
      const b = a[k]; if (b) { cv += b.v; pv += (b.h + b.l + b.c) / 3 * b.v; vv += b.v; x9 += (b.c - x9) * 2 / 10; x21 += (b.c - x21) * 2 / 22; }
      cumV[k] = cv; vw[k] = vv ? pv / vv : (b ? b.c : 0); e9[k] = x9; e21[k] = x21;
    }
    const past = history.filter(Boolean).slice(-20), avgCum = new Array(75).fill(0);
    if (past.length >= 10) for (let k = 0; k < 75; k++) avgCum[k] = mean(past.map(h => h[k]));
    const nd = nifty.get(day), np = niftyPrev.get(day);
    if (prevClose && nd && nd[3] && past.length >= 10) {
      const ctx = { a, nd, np, vw, cumV, avgCum, e9, e21, prev: prevClose, nOpen: nd[0] ? nd[0].o : null };
      const open = a[0].o, y = day.slice(0, 4), turnover = 0;
      const orHi = Math.max(a[0].h, a[1] ? a[1].h : 0, a[2] ? a[2].h : 0), orLo = Math.min(a[0].l, a[1] ? a[1].l : 1e9, a[2] ? a[2].l : 1e9), orMid = (orHi + orLo) / 2;
      const taken = { A: false, B: false, C: false };
      const emit = (s, k, dir, stopRaw, rangePos) => {
        if (taken[s]) return; const t = runTrade(a, k, dir, stopRaw); if (!t) return; taken[s] = true;
        rows.push({ s, day, y, sym, dir, k, score: scoreAt(ctx, k, dir, rangePos), ...t });
      };
      const rangePosAt = (k, n) => { let hi = -1e18, lo = 1e18; for (let j = Math.max(0, k - n + 1); j <= k; j++) if (a[j]) { hi = Math.max(hi, a[j].h); lo = Math.min(lo, a[j].l); } return hi > lo ? (a[k].c - lo) / (hi - lo) : 0.5; };
      for (let k = 3; k <= 66; k++) {
        const b = a[k]; if (!b || !a[k + 1]) continue;
        const c = b.c, ext = (c / open - 1) * 100;
        // A
        if (k <= 14 && !taken.A) {
          if (c > orHi && c > vw[k]) emit('A', k, 1, orMid, rangePosAt(k, 12));
          else if (c < orLo && c < vw[k]) emit('A', k, -1, orMid, rangePosAt(k, 12));
        }
        // B
        if (k >= 15 && k <= 49 && !taken.B && Math.abs(ext) >= 1) {
          const dir = ext > 0 ? 1 : -1, p = a[k - 1]; if (!p || dir * (c - vw[k]) <= 0 || dir * (e9[k] - e21[k]) <= 0) continue;
          let lo = 1e18, hi = -1e18, pullVol = 0, impVol = 0, n1 = 0, n2 = 0;
          for (let j = k - 4; j < k; j++) if (a[j]) { lo = Math.min(lo, a[j].l); hi = Math.max(hi, a[j].h); pullVol += a[j].v; n1++; }
          for (let j = k - 10; j < k - 4; j++) if (a[j]) { impVol += a[j].v; n2++; }
          if (!n1 || !n2) continue;
          const touched = dir === 1 ? lo <= e9[k - 1] * 1.001 : hi >= e9[k - 1] * 0.999;           // pulled back to the 9-bar average
          const lighter = pullVol / n1 < impVol / n2;
          const turn = dir === 1 ? c > b.o && c > p.h : c < b.o && c < p.l;
          if (touched && lighter && turn) emit('B', k, dir, dir === 1 ? lo : hi, rangePosAt(k, 20));
        }
        // C
        if (k >= 50 && !taken.C && Math.abs(ext) >= 1) {
          let hi = -1e18, lo = 1e18, v = 0, n = 0;
          for (let j = k - 10; j < k; j++) if (a[j]) { hi = Math.max(hi, a[j].h); lo = Math.min(lo, a[j].l); v += a[j].v; n++; }
          if (n < 8 || (hi - lo) / c * 100 > 0.8 || b.v < 1.3 * v / n) continue;
          const dir = ext > 0 ? 1 : -1;
          if (dir === 1 ? c > hi && c > vw[k] : c < lo && c < vw[k]) emit('C', k, dir, dir === 1 ? lo : hi, rangePosAt(k, 20));
        }
        if (taken.A && taken.B && taken.C) break;
      }
    }
    history.push(cumV); prevClose = a[74] ? a[74].c : (() => { for (let k = 74; k >= 0; k--) if (a[k]) return a[k].c; return prevClose; })();
  }
}

const files = fs.readdirSync(DIR).filter(f => f.endsWith('.csv') && !/^(NIFTY|INDIAVIX)\.csv$/.test(f));
let n = 0;
for (const f of files) { processStock(f.slice(0, -4), readBars(path.join(DIR, f))); if (++n % 25 === 0) process.stdout.write(`  ${n}/${files.length} stocks, ${rows.length} trades\r`); }
if (FROM > '0000-00-00') { const keep = rows.filter(r => r.day >= FROM); rows.length = 0; rows.push(...keep); }   // history before --from is only used to warm up the volume baseline
fs.writeFileSync(path.join(__dirname, 'data', 'intraday-lab' + (FROM > '0000-00-00' ? '-from-' + FROM : '') + '.json'), JSON.stringify(rows));

function stat(a) {
  if (a.length < 5) return `n=${a.length}`;
  const R = a.map(r => r.r), w = R.filter(x => x > 0), l = R.filter(x => x <= 0);
  const pf = l.length ? w.reduce((x, y) => x + y, 0) / -l.reduce((x, y) => x + y, 0) : Infinity;
  const byDay = new Map(); for (const r of a) { const d = byDay.get(r.day) || []; d.push(r.r); byDay.set(r.day, d); }
  const dm = [...byDay.values()].map(mean), m = mean(dm), sd = Math.sqrt(mean(dm.map(x => (x - m) ** 2)));
  const t = m / (sd / Math.sqrt(dm.length) || 1);
  return `n=${String(a.length).padStart(6)} days ${String(byDay.size).padStart(4)}  win ${(w.length / R.length * 100).toFixed(0).padStart(3)}%  avgR ${(mean(R) >= 0 ? '+' : '') + mean(R).toFixed(3)}  PF ${pf.toFixed(2)}  t(day) ${t.toFixed(1).padStart(5)}`;
}
console.log(`\n${files.length} stocks, ${rows.length} trades. Net of ${COST}% charges, stops ${MINSTOP}-${MAXSTOP}%, target ${RR}R. Positive avgR with t(day) above 2 in BOTH periods is what we need.`);
for (const s of ['A', 'B', 'C']) {
  const name = { A: 'A Opening momentum 09:35-10:30', B: 'B Pullback continuation 10:30-13:30', C: 'C Afternoon breakout 13:30-14:45' }[s];
  console.log(`\n=== ${name}`);
  const a = rows.filter(r => r.s === s);
  for (const cut of [0, 50, 60, 70, 80]) {
    const x = a.filter(r => r.score >= cut);
    console.log(`  score >= ${String(cut).padEnd(3)} all   ${stat(x)}`);
    console.log(`            dev   ${stat(x.filter(r => r.day <= SPLIT))}`);
    console.log(`            hold  ${stat(x.filter(r => r.day > SPLIT))}`);
  }
  console.log(`  long  (score>=70): ${stat(a.filter(r => r.score >= 70 && r.dir === 1))}`);
  console.log(`  short (score>=70): ${stat(a.filter(r => r.score >= 70 && r.dir === -1))}`);
}
