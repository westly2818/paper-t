// Backtest of the Fyers curated automation "Top 5 Gap Up 30min Opening Range Breakout" on our 1-minute files.
// Rules (from the Fyers template page):
//  - 09:15: rank stocks by gap-up % (open vs previous close), take the top 5.
//  - Record each one's high/low from 09:15 to 09:45. After 09:45, if price moves above that high, buy Rs 20,000 worth.
//  - Exit: if any entered stock falls 1% below its entry, square off ALL positions and stop for the day.
//    Also square off everything and stop if combined P&L reaches +10,000 or -10,000. Everything is closed at 15:15.
//  - No re-entry. Stocks that have not triggered keep being watched until an automation-level exit.
//   node gapup-orb.js --fyers data/fyers-1m [--days 440] [--amount 20000] [--stop 1] [--top 5]
// Assumptions I had to make (the template does not say): universe = our NIFTY 200 files; a breakout fills at the
// range high (or the minute's open if it gaps through) plus 0.02% slippage; stops fill at the stop price minus
// slippage; the other positions are closed at that minute's close; gaps over 15% are skipped as corporate-action artifacts.
const fs = require('fs');
const path = require('path');
const { charges } = require('./lib/engine');
const base = require('./config');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const dir = arg('fyers', 'data/fyers-1m'), DAYS = +arg('days', 440), AMOUNT = +arg('amount', 20000), STOP = +arg('stop', 1) / 100, TOP = +arg('top', 5);
const PNL_LIMIT = +arg('pnl', 10000), SLIP = base.slippagePct / 100;
const IST = 5.5 * 3600e3, minOfDay = ms => { const d = new Date(ms + IST); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const dayKey = ms => new Date(ms + IST).toISOString().slice(0, 10);

// ---- load: per symbol compact arrays plus a day index ----
const data = {};
let loaded = 0;
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.csv')) continue;
  const sym = f.slice(0, -4);
  const rows = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').slice(1);
  const n = rows.length, T = new Float64Array(n), O = new Float64Array(n), H = new Float64Array(n), L = new Float64Array(n), C = new Float64Array(n);
  const days = new Map();
  for (let j = 0; j < n; j++) {
    const r = rows[j].split(','), t = Date.parse(r[0]);
    T[j] = t; O[j] = +r[1]; H[j] = +r[2]; L[j] = +r[3]; C[j] = +r[4];
    const k = dayKey(t), d = days.get(k);
    if (!d) days.set(k, { i0: j, i1: j }); else d.i1 = j;
  }
  data[sym] = { T, O, H, L, C, days };
  loaded++;
}
const nifty = data.NIFTY;
if (!nifty) throw new Error('NIFTY.csv missing in ' + dir);
delete data.NIFTY; delete data.INDIAVIX;
const allDays = [...nifty.days.keys()].sort();
const test = allDays.slice(-DAYS);
console.log(`${Object.keys(data).length} stocks, testing ${test.length} sessions ${test[0]} to ${test[test.length - 1]}; Rs ${AMOUNT} per stock, stop ${STOP * 100}%, top ${TOP} gap-ups\n`);

function simDay(day, prevDay) {
  // 1) rank by gap at 09:15
  const cands = [];
  for (const [sym, d] of Object.entries(data)) {
    const cur = d.days.get(day), prev = d.days.get(prevDay);
    if (!cur || !prev || cur.i1 - cur.i0 < 300) continue;
    if (minOfDay(d.T[cur.i0]) !== 9 * 60 + 15) continue;
    const gap = d.O[cur.i0] / d.C[prev.i1] - 1;
    if (gap > 0 && gap < 0.15) cands.push({ sym, d, cur, gap });
  }
  cands.sort((a, b) => b.gap - a.gap);
  const picks = cands.slice(0, TOP);
  if (!picks.length) return null;
  for (const p of picks) {
    let hi = -Infinity, lo = Infinity, j = p.cur.i0;
    for (; j <= p.cur.i1 && minOfDay(p.d.T[j]) < 9 * 60 + 45; j++) { hi = Math.max(hi, p.d.H[j]); lo = Math.min(lo, p.d.L[j]); }
    p.rangeHi = hi; p.rangeLo = lo; p.next = j; p.pos = null; p.done = false;
  }
  // 2) walk the minutes from 09:45 together
  const trades = []; let stopped = false, reason = '';
  const closePos = (p, px, why, t) => {
    const pos = p.pos; if (!pos) return;
    const gross = (px - pos.entry) * pos.qty, fee = charges('SELL', pos.qty * px);
    trades.push({ day, sym: p.sym, gap: p.gap, entry: pos.entry, exit: px, qty: pos.qty, gross, net: gross - fee - pos.fee, why, tIn: pos.t, tOut: t });
    p.pos = null; p.done = true;
  };
  const t0 = Math.min(...picks.map(p => p.d.T[p.next] || Infinity));
  let realizedGross = 0;
  for (let t = t0; t < t0 + 6 * 3600e3 && !stopped; t += 60000) {
    const mod = minOfDay(t);
    const bars = picks.map(p => (p.d.T[p.next] === t ? p.next++ : -1));
    if (mod >= 15 * 60 + 15) {
      picks.forEach((p, i) => { if (p.pos && bars[i] >= 0) closePos(p, p.d.O[bars[i]] * (1 - SLIP), 'Square-off 15:15', t); });
      stopped = true; reason = 'time'; break;
    }
    // stops first (a stock already in), then breakouts
    let stopHit = -1;
    picks.forEach((p, i) => { if (stopHit < 0 && p.pos && bars[i] >= 0 && p.d.L[bars[i]] <= p.pos.entry * (1 - STOP)) stopHit = i; });
    picks.forEach((p, i) => {
      if (p.pos || p.done || bars[i] < 0 || stopHit >= 0) return;
      const j = bars[i];
      if (p.d.H[j] > p.rangeHi) {
        const entry = Math.max(p.rangeHi, p.d.O[j]) * (1 + SLIP), qty = Math.floor(AMOUNT / entry);
        if (qty >= 1) p.pos = { entry, qty, t, fee: charges('BUY', qty * entry) };
      }
    });
    if (stopHit >= 0) {
      const sp = picks[stopHit];
      picks.forEach((p, i) => {
        if (!p.pos) return;
        const px = i === stopHit ? p.pos.entry * (1 - STOP) * (1 - SLIP) : (bars[i] >= 0 ? p.d.C[bars[i]] : p.pos.entry);
        closePos(p, px, i === stopHit ? 'Stop 1% (all out)' : 'Closed because another stock hit its stop', t);
      });
      stopped = true; reason = 'stop'; break;
    }
    // combined P&L at the minute close
    let pnl = trades.reduce((a, x) => a + x.gross, 0);
    picks.forEach((p, i) => { if (p.pos && bars[i] >= 0) pnl += (p.d.C[bars[i]] - p.pos.entry) * p.pos.qty; });
    if (pnl >= PNL_LIMIT || pnl <= -PNL_LIMIT) {
      picks.forEach((p, i) => { if (p.pos) closePos(p, (bars[i] >= 0 ? p.d.C[bars[i]] : p.pos.entry) * (1 - SLIP), pnl > 0 ? 'Combined profit target' : 'Combined loss limit', t); });
      stopped = true; reason = 'pnl'; break;
    }
  }
  picks.forEach(p => { if (p.pos) { const j = Math.min(p.next - 1, p.cur.i1); closePos(p, p.d.C[j], 'Data end', p.d.T[j]); } });
  return { trades, reason, picked: picks.map(p => p.sym) };
}

const dayRes = [];
for (let k = 0; k < test.length; k++) {
  const prevDay = allDays[allDays.indexOf(test[k]) - 1];
  const r = simDay(test[k], prevDay);
  if (r) dayRes.push({ day: test[k], ...r, net: r.trades.reduce((a, t) => a + t.net, 0), gross: r.trades.reduce((a, t) => a + t.gross, 0) });
}

const f = (v, d = 0) => (v == null || !isFinite(v) ? '-' : v.toFixed(d));
function report(label, ds) {
  const traded = ds.filter(d => d.trades.length);
  const trades = traded.flatMap(d => d.trades);
  if (!traded.length) return console.log(label + ': no trades');
  const wins = traded.filter(d => d.net > 0), gw = wins.reduce((a, d) => a + d.net, 0), gl = -traded.filter(d => d.net <= 0).reduce((a, d) => a + d.net, 0);
  let cum = 0, peak = 0, dd = 0, st = 0, ms = 0;
  for (const d of traded) { cum += d.net; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); st = d.net > 0 ? 0 : st + 1; ms = Math.max(ms, st); }
  const mean = cum / traded.length, sd = Math.sqrt(traded.reduce((a, d) => a + (d.net - mean) ** 2, 0) / Math.max(1, traded.length - 1));
  const why = {}; for (const d of traded) why[d.reason] = (why[d.reason] || 0) + 1;
  console.log(`${label}`);
  console.log(`  sessions ${ds.length}, with trades ${traded.length}, stock trades ${trades.length}`);
  console.log(`  NET after charges Rs ${f(cum)}   gross Rs ${f(traded.reduce((a, d) => a + d.gross, 0))}   charges Rs ${f(trades.reduce((a, t) => a + (t.gross - t.net), 0))}`);
  console.log(`  avg per traded day Rs ${f(mean)} (95% range +/- ${f(1.96 * sd / Math.sqrt(traded.length))})   winning days ${f(wins.length / traded.length * 100)}%   profit factor ${gl > 0 ? f(gw / gl, 2) : 'inf'}`);
  console.log(`  max drawdown Rs ${f(dd)}   longest losing-day streak ${ms}   day ends: ${Object.entries(why).map(([k, v]) => k + ' ' + v).join(', ')}`);
}
console.log('GAP-UP 30-min ORB, all sessions'); report('', dayRes);
const mid = Math.floor(dayRes.length / 2);
console.log(); report('First half (' + dayRes[0].day + ' to ' + dayRes[mid - 1].day + ')', dayRes.slice(0, mid));
console.log(); report('Second half (' + dayRes[mid].day + ' to ' + dayRes[dayRes.length - 1].day + ')', dayRes.slice(mid));
const byMonth = {}; for (const d of dayRes) byMonth[d.day.slice(0, 7)] = (byMonth[d.day.slice(0, 7)] || 0) + d.net;
console.log('\nNet Rs by month: ' + Object.entries(byMonth).map(([k, v]) => k + ' ' + f(v)).join(' | '));
const tr = dayRes.flatMap(d => d.trades);
console.log(`Per stock trade: ${tr.length} trades, win ${f(tr.filter(t => t.net > 0).length / tr.length * 100)}%, avg net Rs ${f(tr.reduce((a, t) => a + t.net, 0) / tr.length, 1)} (risk per trade Rs ${f(AMOUNT * STOP)})`);
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/gapup-trades.csv', 'day,sym,gapPct,entry,exit,qty,gross,net,why\n' + tr.map(t => [t.day, t.sym, f(t.gap * 100, 2), f(t.entry, 2), f(t.exit, 2), t.qty, f(t.gross, 1), f(t.net, 1), t.why].join(',')).join('\n'));
console.log('Every trade saved to data/gapup-trades.csv');
