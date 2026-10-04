// Research harness: six PRE-DEFINED candidate strategies on 24 months of Fyers 1-minute data, development vs holdout.
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

// ---------------- the three intraday candidates ----------------
function signalsI1(u) { // VWAP fade: price stretched 0.6 x daily ATR from VWAP between 10:00 and 13:30, fade back to VWAP, stop 0.5 ATR beyond
  const out = [];
  for (const e of u) {
    const s = S[e.sym]; let pv = 0, vv = 0;
    for (let k = 0; k < 255; k++) {
      const i = e.i0 + k, tp = (s.H[i] + s.L[i] + s.C[i]) / 3; pv += tp * s.V[i]; vv += s.V[i];
      if (k < 44 || (k + 1) % 5 !== 0 || vv <= 0) continue;
      const vwap = pv / vv, ext = s.C[i] - vwap;
      if (Math.abs(ext) >= 0.6 * e.f.atr) {
        const side = ext > 0 ? 'short' : 'long', fill = s.C[i];
        out.push({ sym: e.sym, k: k + 1, side, stop: side === 'short' ? fill + 0.5 * e.f.atr : fill - 0.5 * e.f.atr, target: vwap });
        break;
      }
    }
  }
  return out;
}
function signalsI2(u) { // gap fade: gap of 2%+ and a first 5-minute candle against the gap; target half the gap, stop beyond the first candle
  const out = [];
  for (const e of u) {
    if (Math.abs(e.gap) < 0.02) continue;
    const s = S[e.sym], o = s.O[e.i0], c5 = s.C[e.i0 + 4], prev = e.f.close;
    let hi = -Infinity, lo = Infinity; for (let k = 0; k < 5; k++) { hi = Math.max(hi, s.H[e.i0 + k]); lo = Math.min(lo, s.L[e.i0 + k]); }
    if (e.gap > 0 && c5 < o) out.push({ sym: e.sym, k: 5, side: 'short', stop: hi * 1.001, target: prev + 0.5 * (o - prev) });
    if (e.gap < 0 && c5 > o) out.push({ sym: e.sym, k: 5, side: 'long', stop: lo * 0.999, target: prev + 0.5 * (o - prev) });
  }
  return out;
}
function signalsI3(u) { // late-day momentum: at 14:30 take the 3 strongest and 3 weakest stocks (move of 1.5%+ since the open), hold to 15:15, 0.8% stop
  const k = 315, rows = [];
  for (const e of u) { const s = S[e.sym]; rows.push({ e, ret: s.C[e.i0 + k - 1] / s.O[e.i0] - 1 }); }
  const up = rows.filter(r => r.ret >= 0.015).sort((a, b) => b.ret - a.ret).slice(0, 3), dn = rows.filter(r => r.ret <= -0.015).sort((a, b) => a.ret - b.ret).slice(0, 3);
  return [...up.map(r => ({ sym: r.e.sym, k, side: 'long', stop: S[r.e.sym].O[r.e.i0 + k] * 0.992 })), ...dn.map(r => ({ sym: r.e.sym, k, side: 'short', stop: S[r.e.sym].O[r.e.i0 + k] * 1.008 }))];
}
const intradayTrades = { 'I1 VWAP fade': [], 'I2 Gap fade': [], 'I3 Late-day momentum': [] };
for (const day of testDays) {
  const u = universe(day);
  if (u.length < 10) continue;
  intradayTrades['I1 VWAP fade'].push(...execIntraday(day, signalsI1(u)));
  intradayTrades['I2 Gap fade'].push(...execIntraday(day, signalsI2(u)));
  intradayTrades['I3 Late-day momentum'].push(...execIntraday(day, signalsI3(u)));
}

// ---------------- the two swing candidates ----------------
const niftyClose = i => nifty.days[i].c;
function swing(pickFn, regimeOn) {
  const trades = [], bench = [];
  const weekStarts = [];
  for (let q = 1; q < testDays.length; q++) {
    const a = new Date(testDays[q - 1] + 'T00:00:00Z'), b = new Date(testDays[q] + 'T00:00:00Z');
    const wk = d => { const t = new Date(d); t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); return t.getUTCFullYear() * 100 + Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7); };
    if (wk(a) !== wk(b)) weekStarts.push(q);
  }
  for (let w = 0; w + 1 < weekStarts.length; w++) {
    const day = testDays[weekStarts[w]], endDay = testDays[weekStarts[w + 1]];
    const nx = nifty.byDay.get(day);
    if (regimeOn) { let m = 0; for (let q = nx - 20; q < nx; q++) m += niftyClose(q); if (!(niftyClose(nx - 1) > m / 20)) continue; }
    const cands = [];
    for (const sym of syms) {
      const s = S[sym], x = s.byDay.get(day), xe = s.byDay.get(endDay);
      if (x == null || xe == null) continue;
      const f = feat(sym, x);
      if (!f || f.turn < 3e8 || f.close > 4000 || f.close <= f.sm50) continue;
      cands.push({ sym, x, xe, f });
    }
    if (cands.length < 8) continue;
    const entryOf = c => S[c.sym].days[c.x].o, exitOf = c => S[c.sym].days[c.xe].o;
    const artifact = c => { for (let q = c.x; q <= c.xe; q++) { const D = S[c.sym].days; if (Math.abs(D[q].c / D[q - 1].c - 1) > 0.25) return true; } return false; };
    const ok = cands.filter(c => !artifact(c));
    for (const c of ok) bench.push(exitOf(c) / entryOf(c) - 1);
    for (const c of pickFn(ok).slice(0, 5)) {
      const D = S[c.sym].days, entry = entryOf(c) * (1 + 0.0003), qty = Math.floor(4000 / entry);
      if (qty < 1) continue;
      let exit = exitOf(c) * (1 - 0.0003), why = 'week';
      for (let q = c.x; q < c.xe; q++) if (D[q].l <= entry * 0.95) { exit = Math.min(D[q].o, entry * 0.95) * (1 - 0.0003); why = 'stop -5%'; break; }
      const net = (exit - entry) * qty - delivery('BUY', qty * entry) - delivery('SELL', qty * exit);
      trades.push({ day, sym: c.sym, side: 'long', qty, entry, exit, net, ret: net / (qty * entry), why });
    }
  }
  return { trades, benchMean: bench.reduce((a, b) => a + b, 0) / (bench.length || 1) };
}
const sw1 = swing(c => c.sort((a, b) => b.f.mom20 - a.f.mom20), true);
const sw2 = swing(c => c.filter(x => x.f.ret5 >= -0.12).sort((a, b) => a.f.ret5 - b.f.ret5), false);

// ---------------- reporting ----------------
const f2 = (v, d = 2) => (v == null || !isFinite(v) ? '-' : v.toFixed(d));
function stat(tr, key) {
  const n = tr.length; if (!n) return null;
  const vals = tr.map(t => t[key]), mean = vals.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const gw = tr.filter(t => t.net > 0).reduce((a, t) => a + t.net, 0), gl = -tr.filter(t => t.net <= 0).reduce((a, t) => a + t.net, 0);
  let cum = 0, peak = 0, dd = 0; for (const t of tr) { cum += t.net; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  const months = {}; for (const t of tr) months[t.day.slice(0, 7)] = (months[t.day.slice(0, 7)] || 0) + t.net;
  const mv = Object.values(months);
  return { n, mean, ci: 1.96 * sd / Math.sqrt(n), win: tr.filter(t => t.net > 0).length / n * 100, pf: gl > 0 ? gw / gl : Infinity, net: cum, dd, posMonths: mv.filter(x => x > 0).length, months: mv.length };
}
function line(label, tr, key, unit) {
  const s = stat(tr, key);
  if (!s) return console.log(`  ${label.padEnd(12)} no trades`);
  const m = unit === '%' ? `${f2(s.mean * 100)}% (+/-${f2(s.ci * 100)})` : `${f2(s.mean)}R (+/-${f2(s.ci)})`;
  console.log(`  ${label.padEnd(12)} n=${String(s.n).padStart(4)}  avg net ${m.padEnd(18)} win ${f2(s.win, 0)}%  PF ${f2(s.pf)}  net Rs ${f2(s.net, 0).padStart(7)}  maxDD Rs ${f2(s.dd, 0)}  +months ${s.posMonths}/${s.months}`);
}
const all = [];
function block(name, tr, key, unit, extra) {
  console.log(name + (extra ? '   ' + extra : ''));
  const dev = tr.filter(t => t.day <= DEV_END), ho = tr.filter(t => t.day > DEV_END);
  line('development', dev, key, unit); line('holdout', ho, key, unit); line('all', tr, key, unit);
  line('long', tr.filter(t => t.side === 'long'), key, unit); line('short', tr.filter(t => t.side === 'short'), key, unit);
  console.log();
  all.push({ name, dev: stat(dev, key), ho: stat(ho, key), key });
}
console.log('=== INTRADAY (R = net result / risk at the stop; costs included) ===\n');
for (const [k, tr] of Object.entries(intradayTrades)) block(k, tr, 'r', 'R');
console.log('=== SWING (weekly, return per trade after delivery charges and 0.03% slippage per side) ===\n');
block('S1 20-day momentum (Nifty above 20DMA only)', sw1.trades, 'ret', '%', `universe average week (no costs): ${f2(sw1.benchMean * 100)}%`);
block('S2 5-day reversal in uptrends', sw2.trades, 'ret', '%', `universe average week (no costs): ${f2(sw2.benchMean * 100)}%`);
fs.mkdirSync('data', { recursive: true });
for (const [k, tr] of Object.entries({ ...intradayTrades, S1: sw1.trades, S2: sw2.trades })) fs.writeFileSync(`data/research-${k.split(' ')[0]}.csv`, 'day,sym,side,qty,entry,exit,net,why\n' + tr.map(t => [t.day, t.sym, t.side, t.qty, f2(t.entry), f2(t.exit), f2(t.net, 1), t.why].join(',')).join('\n'));
console.log('Trade lists saved to data/research-*.csv');
