// Pre-registered test, round 3: Bollinger mean reversion, gap-and-go and intraday pairs, each with a random control.
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
const nifty = S.NIFTY; delete S.NIFTY; delete S.INDIAVIX; const V = require('./lib/validate');
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


// ======================= PRE-REGISTERED STRATEGIES, ROUND 3 (frozen before the first run) =======================
// Same loader, executor, MIS charges and 0.02% slippage as research.js. One signal per stock per day. Dev to 2026-03-31, holdout after.
//   Q1 Bollinger reversion  5-min Bollinger(20, 2) with RSI(14): close below the lower band and RSI < 30 -> long; above the upper band and
//                           RSI > 70 -> short. 10:00-14:00. Skip if the 50-bar EMA moved more than 0.3% against the trade over the last 12 bars
//                           (the trend filter the sources ask for). Stop 0.7%. Target = the 20-bar average (skipped if closer than 0.4%).
//   Q2 Gap-and-go           stocks gapping 1.5% or more at the open: after 09:30 a 5-min close beyond the opening range IN THE DIRECTION OF THE GAP,
//                           right side of VWAP, up to 10:30. Stop = opening-range midpoint clamped to 0.4-1.2%. Target 1.5R.
//   Q3 Intraday pairs       10 same-sector pairs, ratio of 5-min closes. Baseline = mean and standard deviation of the ratio over the previous 5 sessions.
//                           First time between 10:00 and 13:30 that |z| >= 2: long the cheap leg, short the rich leg, Rs 5,000 each. Exit when |z| <= 0.5
//                           (win), |z| >= 3.5 (stop) or 15:15. At most 3 pairs a day.
//   Q4 RANDOM control       single-stock random entry, 0.7% stop, 1.5R target (the control for Q1 and Q2). Pairs control: same pairs, random time, random
//                           direction, same exits.
// Pass rule: positive average net result in BOTH development and holdout and a day-block sign-flip p below 0.05 after adjusting for the 3 strategies.
const TARGET_R = 1.5, FIXED_STOP = 0.007;
const vwapAt = (s, i0, upto) => { let pv = 0, vv = 0; for (let k = 0; k <= upto; k++) { const i = i0 + k, tp = (s.H[i] + s.L[i] + s.C[i]) / 3; pv += tp * s.V[i]; vv += s.V[i]; } return vv > 0 ? pv / vv : NaN; };
const fixedStop = (entry, side) => (side === 'long' ? entry * (1 - FIXED_STOP) : entry * (1 + FIXED_STOP));
const clampStop = (entry, raw, dir) => { let p = Math.abs(entry - raw) / entry; if (dir === 1 ? raw >= entry : raw <= entry) p = 0.012; p = Math.max(0.004, Math.min(0.012, p)); return entry * (1 - dir * p); };
const closes5 = (s, i0) => { const a = []; for (let m = 4; m < 375; m += 5) a.push(s.C[i0 + m]); return a; };
function ema(arr, n) { const a = 2 / (n + 1), out = []; let v = arr[0]; for (let i = 0; i < arr.length; i++) { v = i ? v + a * (arr[i] - v) : arr[0]; out.push(v); } return out; }
function rsi14(cl) { const out = new Array(cl.length).fill(NaN); let g = 0, l = 0; for (let i = 1; i <= 14 && i < cl.length; i++) { const d = cl[i] - cl[i - 1]; if (d > 0) g += d; else l -= d; } g /= 14; l /= 14; for (let i = 14; i < cl.length; i++) { if (i > 14) { const d = cl[i] - cl[i - 1]; g = (g * 13 + (d > 0 ? d : 0)) / 14; l = (l * 13 + (d < 0 ? -d : 0)) / 14; } out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } return out; }

function sigQ1(u) {
  const out = [];
  for (const e of u) {
    const s = S[e.sym], cl = closes5(s, e.i0), r = rsi14(cl), e50 = ema(cl, 50);
    for (let j = 20; j < cl.length - 1; j++) {
      const m = j * 5 + 4, k = m + 1; if (k < 45 || k > 285) continue;
      let sum = 0; for (let q = j - 19; q <= j; q++) sum += cl[q]; const sma = sum / 20; let v = 0; for (let q = j - 19; q <= j; q++) v += (cl[q] - sma) ** 2; const sd = Math.sqrt(v / 20);
      const side = cl[j] < sma - 2 * sd && r[j] < 30 ? 'long' : cl[j] > sma + 2 * sd && r[j] > 70 ? 'short' : null; if (!side) continue;
      const slope = (e50[j] / e50[j - 12] - 1), dir = side === 'long' ? 1 : -1;
      if (dir * slope < -0.003) continue;                      // trend against the trade
      const entry = s.O[e.i0 + k]; if (Math.abs(sma - entry) / entry < 0.004) continue;
      out.push({ sym: e.sym, k, side, stop: fixedStop(entry, side), target: sma }); break;
    }
  }
  return out;
}
function sigQ2(u) {
  const out = [];
  for (const e of u) {
    if (Math.abs(e.gap) < 0.015) continue;
    const s = S[e.sym], gd = e.gap > 0 ? 1 : -1; let hi = -Infinity, lo = Infinity;
    for (let k = 0; k < 15; k++) { hi = Math.max(hi, s.H[e.i0 + k]); lo = Math.min(lo, s.L[e.i0 + k]); }
    const mid = (hi + lo) / 2;
    for (let m = 19; m < 75; m += 5) {
      const c = s.C[e.i0 + m], vw = vwapAt(s, e.i0, m), k = m + 1;
      if (gd === 1 ? !(c > hi * 1.0005 && c > vw) : !(c < lo * 0.9995 && c < vw)) continue;
      const entry = s.O[e.i0 + k], stop = clampStop(entry, mid, gd);
      out.push({ sym: e.sym, k, side: gd === 1 ? 'long' : 'short', stop, target: entry + gd * TARGET_R * Math.abs(entry - stop) }); break;
    }
  }
  return out;
}
const RG = require('./lib/validate').rng(20261015);
function sigQ4(u) { return u.filter(() => RG() < 0.35).map(e => { const k = 30 + Math.floor(RG() * 255), side = RG() < 0.5 ? 'long' : 'short', entry = S[e.sym].O[e.i0 + k], dir = side === 'long' ? 1 : -1, stop = fixedStop(entry, side); return { sym: e.sym, k, side, stop, target: entry + dir * TARGET_R * Math.abs(entry - stop) }; }); }

// ---------------- pairs ----------------
const PAIRS = [['HDFCBANK', 'ICICIBANK'], ['AXISBANK', 'KOTAKBANK'], ['SBIN', 'BANKBARODA'], ['TCS', 'INFY'], ['HCLTECH', 'WIPRO'], ['SUNPHARMA', 'CIPLA'], ['TATASTEEL', 'JSWSTEEL'], ['NTPC', 'POWERGRID'], ['MARUTI', 'M&M'], ['HDFCBANK', 'AXISBANK']].filter(p => S[p[0]] && S[p[1]]);
const LEG = 5000;
function pairTrades(day, random) {
  const ci = calendar.indexOf(day); if (ci < 6) return [];
  const prior = calendar.slice(ci - 5, ci), out = [];
  for (const [a, b] of PAIRS) {
    const sa = S[a], sb = S[b], xa = sa.byDay.get(day), xb = sb.byDay.get(day);
    if (xa == null || xb == null || sa.days[xa].n < 370 || sb.days[xb].n < 370) continue;
    const ia = sa.days[xa].i0, ib = sb.days[xb].i0, base = [];
    let ok = true;
    for (const d of prior) { const pa = sa.byDay.get(d), pb = sb.byDay.get(d); if (pa == null || pb == null || sa.days[pa].n < 370 || sb.days[pb].n < 370) { ok = false; break; } for (let m = 4; m < 375; m += 5) base.push(sa.C[sa.days[pa].i0 + m] / sb.C[sb.days[pb].i0 + m]); }
    if (!ok) continue;
    const mu = V.mean(base), sd = V.sd(base); if (!(sd > 0)) continue;
    const z = m => (sa.C[ia + m] / sb.C[ib + m] - mu) / sd;
    let entryM = null, dirA = 0;
    if (!random) { for (let m = 44; m <= 209; m += 5) { const zz = z(m); if (Math.abs(zz) >= 2) { entryM = m; dirA = zz > 0 ? -1 : 1; break; } } }       // ratio high = A rich: short A, long B
    else if (RG() < 0.35) { entryM = 44 + 5 * Math.floor(RG() * 34); dirA = RG() < 0.5 ? 1 : -1; }
    if (entryM == null) continue;
    const k = entryM + 1; let exitK = 360, why = 'time';
    for (let m = entryM + 5; m < 360; m += 5) { const zz = Math.abs(z(m)); if (zz <= 0.5) { exitK = m + 1; why = 'target'; break; } if (zz >= 3.5) { exitK = m + 1; why = 'stop'; break; } }
    const leg = (s, i0, dir) => { const pe = s.O[i0 + k] * (1 + dir * SLIP), px = s.O[i0 + exitK] * (1 - dir * SLIP), q = Math.floor(LEG / pe); return { gross: (px - pe) * dir * q, fee: charges('BUY', q * (dir === 1 ? pe : px)) + charges('SELL', q * (dir === 1 ? px : pe)) }; };
    const A = leg(sa, ia, dirA), B = leg(sb, ib, -dirA), net = A.gross + B.gross - A.fee - B.fee;
    out.push({ day, sym: a + '/' + b, side: dirA === 1 ? 'long' : 'short', k, net, r: net / (2 * LEG) * 100, why, gross: A.gross + B.gross, fees: A.fee + B.fee });
  }
  return out.sort((x, y) => x.k - y.k).slice(0, 3);
}

const results = { 'Q1 Bollinger reversion': [], 'Q2 Gap-and-go': [], 'Q3 Intraday pairs': [], 'Q4 RANDOM single-stock': [], 'Q4b RANDOM pairs': [] };
for (const day of testDays) {
  const u = universe(day);
  if (u.length >= 10) { results['Q1 Bollinger reversion'].push(...execIntraday(day, sigQ1(u))); results['Q2 Gap-and-go'].push(...execIntraday(day, sigQ2(u))); results['Q4 RANDOM single-stock'].push(...execIntraday(day, sigQ4(u))); }
  results['Q3 Intraday pairs'].push(...pairTrades(day, false)); results['Q4b RANDOM pairs'].push(...pairTrades(day, true));
}

const V2 = require('./lib/validate'), f2 = (v, d = 2) => (v == null || !isFinite(v) ? '-' : (v >= 0 && d ? '+' : '') + v.toFixed(d));
const isPair = n => n.includes('pairs');
function part(tr, pair) {
  if (!tr.length) return 'none';
  const gw = tr.filter(t => t.net > 0).reduce((a, t) => a + t.net, 0), gl = -tr.filter(t => t.net <= 0).reduce((a, t) => a + t.net, 0);
  return `n=${String(tr.length).padStart(4)}  win ${String(Math.round(tr.filter(t => t.net > 0).length / tr.length * 100)).padStart(3)}%  avg ${pair ? f2(V2.mean(tr.map(t => t.r)), 3) + '% of Rs10k' : f2(V2.mean(tr.map(t => t.r)), 3) + 'R'}  PF ${(gl > 0 ? gw / gl : 9).toFixed(2)}  net Rs ${String(Math.round(tr.reduce((a, t) => a + t.net, 0))).padStart(6)}`;
}
console.log('Strategy                period        results (net of all charges and slippage)');
const verdicts = [];
for (const [name, tr] of Object.entries(results)) {
  const pair = isPair(name), dev = tr.filter(t => t.day <= DEV_END), ho = tr.filter(t => t.day > DEV_END);
  console.log(`${name.padEnd(23)} development   ${part(dev, pair)}`);
  console.log(`${''.padEnd(23)} holdout       ${part(ho, pair)}`);
  if (pair && tr.length) { const w = tr.filter(t => t.why === 'target').length, st = tr.filter(t => t.why === 'stop').length; console.log(`${''.padEnd(23)} exits: converged ${w}, stopped ${st}, held to 15:15 ${tr.length - w - st}; gross Rs ${Math.round(tr.reduce((a, t) => a + t.gross, 0))}, charges Rs ${Math.round(tr.reduce((a, t) => a + t.fees, 0))}`); }
  if (tr.length >= 20) {
    const sf = V2.signFlipTest(tr.map(t => t.r), tr.map(t => t.day)), hoBS = ho.length >= 8 ? V2.clusterBootstrap(ho.map(t => t.r), ho.map(t => t.day), { n: 2000 }) : null;
    const adj = V2.sidak(sf.p, 3), pass = !name.includes('RANDOM') && V2.mean(dev.map(t => t.r)) > 0 && V2.mean(ho.map(t => t.r)) > 0 && adj < 0.05;
    console.log(`${''.padEnd(23)} sign-flip p ${sf.p.toFixed(4)}, adjusted ${adj.toFixed(4)}${hoBS ? `, holdout 95% range ${f2(hoBS.meanLo, 3)} to ${f2(hoBS.meanHi, 3)}` : ''}  ->  ${name.includes('RANDOM') ? 'control' : pass ? 'PASSES' : 'does not pass'}`);
    if (!name.includes('RANDOM')) verdicts.push([name, pass]);
  }
  console.log();
}
console.log(`${verdicts.filter(v => v[1]).length} of ${verdicts.length} strategies pass the frozen rule. Pairs used: ${PAIRS.map(p => p.join('/')).join(', ')}`);
fs.mkdirSync('data', { recursive: true });
for (const [name, tr] of Object.entries(results)) fs.writeFileSync(`data/strat3-${name.split(' ')[0]}.csv`, 'day,sym,side,net,r\n' + tr.map(t => [t.day, t.sym, t.side, f2(t.net, 1), f2(t.r, 3)].join(',')).join('\n'));
