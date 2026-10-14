// Pre-registered test of intraday strategies from the standard Indian intraday set (CPR, previous-day break, EMA cross, RSI) plus a random control.
//   node --max-old-space-size=10240 research.js --fyers data/fyers-1m
// Intraday candidates (MIS charges, 0.02% slippage per side, risk Rs 200 per trade, Rs 10,000 max per stock, max 3 open, 6 trades/day):
//   I1 VWAP fade, I2 gap fade, I3 late-day momentum.
// Swing candidates (delivery charges, weekly, 5 slots of Rs 4,000): S1 20-day momentum, S2 5-day reversal.
// Parameters below are fixed in advance. Do not tune them after seeing the result.
const fs = require('fs');
const path = require('path');
const { charges } = require('./lib/engine');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const dir = arg('fyers', 'data/fyers-1m');
const DEV_END = '2026-03-31', TEST_START = '2024-12-23';
const CAPITAL = 20000, RISK = 200, MAXPOS_VAL = 10000, SLIP = 0.0002;
const IST = 5.5 * 3600e3, dayKey = ms => new Date(ms + IST).toISOString().slice(0, 10);

// ---------------- load ----------------
const S = {};
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.csv')) continue;
  const sym = f.slice(0, -4);
  const rows = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').slice(1);
  const n = rows.length, T = new Float64Array(n), O = new Float64Array(n), H = new Float64Array(n), L = new Float64Array(n), C = new Float64Array(n), V = new Float64Array(n);
  for (let j = 0; j < n; j++) { const r = rows[j].split(','); T[j] = Date.parse(r[0]); O[j] = +r[1]; H[j] = +r[2]; L[j] = +r[3]; C[j] = +r[4]; V[j] = +r[5]; }
  // daily table from the minutes
  const days = [], i0 = [], len = [], dO = [], dH = [], dL = [], dC = [], dV = [];
  let cur = null;
  for (let j = 0; j < n; j++) {
    const k = dayKey(T[j]);
    if (!cur || cur.k !== k) { cur = { k, i0: j, o: O[j], h: H[j], l: L[j], c: C[j], v: V[j], n: 1 }; days.push(cur); }
    else { cur.h = Math.max(cur.h, H[j]); cur.l = Math.min(cur.l, L[j]); cur.c = C[j]; cur.v += V[j]; cur.n++; }
  }
  S[sym] = { T, O, H, L, C, V, days, byDay: new Map(days.map((d, x) => [d.k, x])) };
}
const nifty = S.NIFTY; delete S.NIFTY; delete S.INDIAVIX;
const syms = Object.keys(S);
const calendar = nifty.days.map(d => d.k);
const testDays = calendar.filter(d => d >= TEST_START);
console.log(`${syms.length} stocks, ${testDays.length} test sessions (${testDays[0]} to ${testDays[testDays.length - 1]}); development to ${DEV_END}\n`);

// features from days strictly before day index `x` in the stock's own table
const feat = (s, x) => {
  const D = S[s].days;
  if (x < 55) return null;
  let tr = 0; for (let q = x - 14; q < x; q++) tr += Math.max(D[q].h - D[q].l, Math.abs(D[q].h - D[q - 1].c), Math.abs(D[q].l - D[q - 1].c));
  const atr = tr / 14, close = D[x - 1].c;
  let sm50 = 0; for (let q = x - 50; q < x; q++) sm50 += D[q].c; sm50 /= 50;
  let turn = 0; for (let q = x - 20; q < x; q++) turn += D[q].c * D[q].v; turn /= 20;
  return { atr, atrPct: atr / close * 100, close, sm50, turn, mom20: close / D[x - 21].c - 1, ret5: close / D[x - 6].c - 1 };
};

// ---------------- intraday executor ----------------
const delivery = (side, v) => {
  const brk = Math.min(20, v * 0.0003), stt = v * 0.001, txn = v * 0.0000297, sebi = v * 0.000001, stamp = side === 'BUY' ? v * 0.00015 : 0;
  return brk + stt + txn + sebi + stamp + 0.18 * (brk + txn + sebi);
};
const SQ = 360; // minute index of 15:15 (09:15 = 0)
function execIntraday(day, signals) {
  signals.sort((a, b) => a.k - b.k);
  const out = [], open = []; let tradesToday = 0, realized = 0;
  for (const sg of signals) {
    for (let q = open.length - 1; q >= 0; q--) if (open[q].exitK <= sg.k) { realized += open[q].net; open.splice(q, 1); }
    if (open.length >= 3 || tradesToday >= 6 || realized <= -CAPITAL * 0.03) continue;
    if (open.some(p => p.sym === sg.sym)) continue;
    const s = S[sg.sym], x = s.byDay.get(day), i0 = s.days[x].i0, d = sg.side === 'long' ? 1 : -1;
    const entry = s.O[i0 + sg.k] * (1 + d * SLIP), dist = Math.abs(entry - sg.stop);
    if (dist < entry * 0.004 || (d === 1 ? sg.stop >= entry : sg.stop <= entry)) continue;
    const qty = Math.floor(Math.min(RISK / dist, MAXPOS_VAL / entry));
    if (qty < 1) continue;
    let exit = null, exitK = SQ, why = 'time';
    for (let j = sg.k; j <= SQ && i0 + j < s.days[x].i0 + s.days[x].n; j++) {
      const i = i0 + j;
      if (j === SQ) { exit = s.O[i] * (1 - d * SLIP); break; }
      if (d === 1 ? s.L[i] <= sg.stop : s.H[i] >= sg.stop) { exit = (j === sg.k ? Math.min(s.O[i], sg.stop) : sg.stop) * (1 - d * SLIP); if (d === -1) exit = (j === sg.k ? Math.max(s.O[i], sg.stop) : sg.stop) * (1 - d * SLIP); exitK = j; why = 'stop'; break; }
      if (sg.target != null && (d === 1 ? s.H[i] >= sg.target : s.L[i] <= sg.target)) { exit = sg.target; exitK = j; why = 'target'; break; }
    }
    if (exit == null) { const e = s.days[x].i0 + s.days[x].n - 1; exit = s.C[e]; exitK = SQ; why = 'data end'; }
    const gross = (exit - entry) * d * qty, fee = charges('BUY', qty * (d === 1 ? entry : exit)) + charges('SELL', qty * (d === 1 ? exit : entry));
    const net = gross - fee;
    tradesToday++;
    const rec = { day, sym: sg.sym, side: sg.side, qty, entry, exit, net, r: net / (dist * qty), why, exitK };
    open.push(rec); out.push(rec);
  }
  return out;
}

// eligible stocks for a day (prior-day information only), same filters as the live bot's morning plan minus the trend ranking
function universe(day) {
  const u = [];
  for (const sym of syms) {
    const s = S[sym], x = s.byDay.get(day);
    if (x == null || s.days[x].n < 370) continue;
    const f = feat(sym, x);
    if (!f || f.atrPct < 1 || f.atrPct > 4.5 || f.turn < 3e8 || f.close > MAXPOS_VAL * 1.0 * 1.5) continue;
    const gap = s.O[s.days[x].i0] / f.close - 1;
    if (Math.abs(gap) > 0.15) continue;
    u.push({ sym, x, f, gap, i0: s.days[x].i0 });
  }
  return u;
}


// ======================= PRE-REGISTERED STRATEGIES (frozen before the first run) =======================
// Same loader, executor (3 open, 6 trades a day, 3% day stop), MIS charges and 0.02% slippage as research.js. One signal per stock per day.
// Entry is the open of the minute after a 5-minute bar closes. Exit: stop, target, or 15:15. Development to 2026-03-31, holdout after.
//   P1 CPR-narrow ORB   previous-day CPR width (|TC-BC| / pivot) under 0.20%: 5-min close beyond the 09:15-09:30 range, right side of VWAP,
//                       09:30-10:30. Stop = opening-range midpoint clamped to 0.4-1.2% of price. Target 1.5R.
//   P2 CPR-wide ORB     the same rule on days with CPR width of 0.20% or more (the comparison that shows whether narrow CPR matters).
//   P3 Prev-day break   5-min close beyond the previous day's high (long) or low (short) by 0.05%, right side of VWAP, 09:30-10:30.
//                       Stop 0.7% of price, target 1.5R.
//   P4 EMA 9/21 cross   5-min close crosses 9-EMA over 21-EMA with price on the right side of VWAP, 10:00-14:00. Stop 0.7%, target 1.5R.
//   P5 RSI extreme      5-min RSI(14) below 20 (long) or above 80 (short), 10:00-14:00. Stop 0.7%, target 1.5R.
//   P6 RANDOM control   a random 5-minute bar between 09:30 and 14:00, random side. Stop 0.7%, target 1.5R. Shows what costs alone do.
// Pass rule: positive average net R in BOTH development and holdout, a day-block sign-flip p below 0.05 after adjusting for the 6 tests,
// and the holdout 95% range not wholly below zero. Nothing is tuned after the first run.
const TARGET_R = 1.5, FIXED_STOP = 0.007, NARROW = 0.002;
const vwapAt = (s, i0, upto) => { let pv = 0, vv = 0; for (let k = 0; k <= upto; k++) { const i = i0 + k, tp = (s.H[i] + s.L[i] + s.C[i]) / 3; pv += tp * s.V[i]; vv += s.V[i]; } return vv > 0 ? pv / vv : NaN; };
const clampStop = (entry, raw, dir) => { let p = Math.abs(entry - raw) / entry; if (dir === 1 ? raw >= entry : raw <= entry) p = 0.012; p = Math.max(0.004, Math.min(0.012, p)); return entry * (1 - dir * p); };
const mk = (e, k, side, stop) => { const d = side === 'long' ? 1 : -1, entry = S[e.sym].O[e.i0 + k], tgt = entry + d * TARGET_R * Math.abs(entry - stop); return { sym: e.sym, k, side, stop, target: tgt }; };
const fixedStop = (e, k, side) => { const entry = S[e.sym].O[e.i0 + k]; return side === 'long' ? entry * (1 - FIXED_STOP) : entry * (1 + FIXED_STOP); };
const barClose = (s, i0, m) => s.C[i0 + m];                // close of the 5-min bar ending at minute m (m = 4, 9, 14 ...)

function cprWidth(e) { const p = S[e.sym].days[e.x - 1]; if (!p) return NaN; const P = (p.h + p.l + p.c) / 3, bc = (p.h + p.l) / 2, tc = 2 * P - bc; return Math.abs(tc - bc) / P; }

function orbSignal(e, narrow) {
  const w = cprWidth(e); if (!Number.isFinite(w) || (narrow ? w >= NARROW : w < NARROW)) return null;
  const s = S[e.sym]; let hi = -Infinity, lo = Infinity;
  for (let k = 0; k < 15; k++) { hi = Math.max(hi, s.H[e.i0 + k]); lo = Math.min(lo, s.L[e.i0 + k]); }
  const mid = (hi + lo) / 2, range = (hi - lo) / mid; if (range < 0.003 || range > 0.025) return null;
  for (let m = 19; m < 75; m += 5) {                       // bars ending 09:34 ... 10:29
    const c = barClose(s, e.i0, m), vw = vwapAt(s, e.i0, m), k = m + 1;
    const side = c > hi * 1.0005 ? 'long' : c < lo * 0.9995 ? 'short' : null; if (!side) continue;
    if (side === 'long' ? !(c > vw) : !(c < vw)) continue;
    const entry = s.O[e.i0 + k], dir = side === 'long' ? 1 : -1, stop = clampStop(entry, mid, dir);
    return { sym: e.sym, k, side, stop, target: entry + dir * TARGET_R * Math.abs(entry - stop) };
  }
  return null;
}
const sigP1 = u => u.map(e => orbSignal(e, true)).filter(Boolean);
const sigP2 = u => u.map(e => orbSignal(e, false)).filter(Boolean);
function sigP3(u) {
  const out = [];
  for (const e of u) {
    const p = S[e.sym].days[e.x - 1]; if (!p) continue; const s = S[e.sym];
    for (let m = 19; m < 75; m += 5) {
      const c = barClose(s, e.i0, m), vw = vwapAt(s, e.i0, m), k = m + 1;
      const side = c > p.h * 1.0005 ? 'long' : c < p.l * 0.9995 ? 'short' : null; if (!side) continue;
      if (side === 'long' ? !(c > vw) : !(c < vw)) continue;
      out.push(mk(e, k, side, fixedStop(e, k, side))); break;
    }
  }
  return out;
}
function ema(arr, n) { const a = 2 / (n + 1), out = []; let v = arr[0]; for (let i = 0; i < arr.length; i++) { v = i ? v + a * (arr[i] - v) : arr[0]; out.push(v); } return out; }
function sigP4(u) {
  const out = [];
  for (const e of u) {
    const s = S[e.sym], cl = []; for (let m = 4; m < 375; m += 5) cl.push(s.C[e.i0 + m]);
    const e9 = ema(cl, 9), e21 = ema(cl, 21);
    for (let j = 1; j < cl.length - 1; j++) {
      const m = j * 5 + 4, k = m + 1; if (k < 45 || k > 285) continue;      // 10:00 to 14:00
      const up = e9[j - 1] <= e21[j - 1] && e9[j] > e21[j], dn = e9[j - 1] >= e21[j - 1] && e9[j] < e21[j]; if (!up && !dn) continue;
      const vw = vwapAt(s, e.i0, m), side = up ? 'long' : 'short';
      if (side === 'long' ? !(cl[j] > vw) : !(cl[j] < vw)) continue;
      out.push(mk(e, k, side, fixedStop(e, k, side))); break;
    }
  }
  return out;
}
function rsi14(cl) { const out = new Array(cl.length).fill(NaN); let g = 0, l = 0; for (let i = 1; i <= 14 && i < cl.length; i++) { const d = cl[i] - cl[i - 1]; if (d > 0) g += d; else l -= d; } g /= 14; l /= 14; for (let i = 14; i < cl.length; i++) { if (i > 14) { const d = cl[i] - cl[i - 1]; g = (g * 13 + (d > 0 ? d : 0)) / 14; l = (l * 13 + (d < 0 ? -d : 0)) / 14; } out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } return out; }
function sigP5(u) {
  const out = [];
  for (const e of u) {
    const s = S[e.sym], cl = []; for (let m = 4; m < 375; m += 5) cl.push(s.C[e.i0 + m]);
    const r = rsi14(cl);
    for (let j = 15; j < cl.length - 1; j++) {
      const m = j * 5 + 4, k = m + 1; if (k < 45 || k > 285) continue;
      const side = r[j] < 20 ? 'long' : r[j] > 80 ? 'short' : null; if (!side) continue;
      out.push(mk(e, k, side, fixedStop(e, k, side))); break;
    }
  }
  return out;
}
const rnd = V => { const g = V.rng(20261014); return g; };
const RG = require('./lib/validate').rng(20261014);
function sigP6(u) { return u.filter(() => RG() < 0.35).map(e => { const k = 30 + Math.floor(RG() * 255), side = RG() < 0.5 ? 'long' : 'short'; return mk(e, k, side, fixedStop(e, k, side)); }); }

const STRATS = { 'P1 CPR-narrow ORB': sigP1, 'P2 CPR-wide ORB': sigP2, 'P3 Prev-day break': sigP3, 'P4 EMA 9/21 cross': sigP4, 'P5 RSI extreme': sigP5, 'P6 RANDOM control': sigP6 };
const results = Object.fromEntries(Object.keys(STRATS).map(k => [k, []]));
const dayKind = {};
for (const day of testDays) {
  const nx = nifty.byDay.get(day); const prev = nifty.days[nx - 1], cur = nifty.days[nx];
  dayKind[day] = prev ? ((cur.c / prev.c - 1) * 100 > 0.3 ? 'up' : (cur.c / prev.c - 1) * 100 < -0.3 ? 'down' : 'flat') : 'flat';
  const u = universe(day); if (u.length < 10) continue;
  for (const [name, fn] of Object.entries(STRATS)) results[name].push(...execIntraday(day, fn(u)));
}

// ---------------- report ----------------
const V = require('./lib/validate'), f2 = (v, d = 2) => (v == null || !isFinite(v) ? '-' : (v >= 0 && d ? '+' : '') + v.toFixed(d));
function part(tr) {
  if (!tr.length) return 'none';
  const r = tr.map(t => t.r), gw = tr.filter(t => t.net > 0).reduce((a, t) => a + t.net, 0), gl = -tr.filter(t => t.net <= 0).reduce((a, t) => a + t.net, 0);
  return `n=${String(tr.length).padStart(4)}  win ${String(Math.round(tr.filter(t => t.net > 0).length / tr.length * 100)).padStart(3)}%  avg ${f2(V.mean(r), 3)}R  PF ${f2(gl > 0 ? gw / gl : 9, 2).replace('+', '')}  net Rs ${String(Math.round(tr.reduce((a, t) => a + t.net, 0))).padStart(6)}`;
}
console.log('Strategy             period        results (net of all charges and slippage)');
const verdicts = [];
for (const [name, tr] of Object.entries(results)) {
  const dev = tr.filter(t => t.day <= DEV_END), ho = tr.filter(t => t.day > DEV_END);
  console.log(`${name.padEnd(20)} development   ${part(dev)}`);
  console.log(`${''.padEnd(20)} holdout       ${part(ho)}`);
  const up = tr.filter(t => dayKind[t.day] === 'up'), dn = tr.filter(t => dayKind[t.day] === 'down');
  console.log(`${''.padEnd(20)} up days ${part(up)}   |   down days ${part(dn)}`);
  const longs = tr.filter(t => t.side === 'long'), shorts = tr.filter(t => t.side === 'short');
  console.log(`${''.padEnd(20)} long ${part(longs)}   |   short ${part(shorts)}`);
  if (tr.length >= 20) {
    const sf = V.signFlipTest(tr.map(t => t.r), tr.map(t => t.day)), hoBS = ho.length >= 8 ? V.clusterBootstrap(ho.map(t => t.r), ho.map(t => t.day), { n: 2000 }) : null;
    const adj = V.sidak(sf.p, 6), pass = V.mean(dev.map(t => t.r)) > 0 && V.mean(ho.map(t => t.r)) > 0 && adj < 0.05 && hoBS && hoBS.meanHi > 0 && hoBS.meanLo > -9;
    console.log(`${''.padEnd(20)} sign-flip p ${f2(sf.p, 4).replace('+', '')}, adjusted ${f2(adj, 4).replace('+', '')}${hoBS ? `, holdout 95% range ${f2(hoBS.meanLo, 3)} to ${f2(hoBS.meanHi, 3)}R` : ''}  ->  ${name.startsWith('P6') ? 'control' : pass ? 'PASSES' : 'does not pass'}`);
    if (!name.startsWith('P6')) verdicts.push([name, pass]);
  }
  console.log();
}
console.log(`${verdicts.filter(v => v[1]).length} of ${verdicts.length} strategies pass the frozen rule.`);
fs.mkdirSync('data', { recursive: true });
for (const [name, tr] of Object.entries(results)) fs.writeFileSync(`data/strat2-${name.split(' ')[0]}.csv`, 'day,sym,side,qty,entry,exit,net,r,why\n' + tr.map(t => [t.day, t.sym, t.side, t.qty, f2(t.entry, 2), f2(t.exit, 2), f2(t.net, 1), f2(t.r, 3), t.why].join(',')).join('\n'));
