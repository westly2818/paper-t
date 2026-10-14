// Backtest of the Intraday Short Straddle (ISS) on Nifty weekly options, modelled from Nifty and India VIX 1-minute data.
//   node straddle-sim.js [--dir data/fyers-1m]
// WHAT THIS IS: option prices are NOT real quotes (Fyers has no history of expired contracts). They come from Black-Scholes with
// implied volatility = 0.93 x India VIX (the scale fitted to two real ATM chains recorded on 8 Oct 2026: 0.92 at 11:29, 0.94 at 15:15)
// on a trading-day clock (calendar-clock fit 0.91 is shown as a sensitivity). So the result shows what the RULES earn if option prices
// behave like that model; real skew, bid-ask width and sudden IV jumps are not captured except through the slippage setting.
// FROZEN GRID (written before the first run): entry 10:00 at the open of that minute, ATM strike (50-point step), CE and PE sold at market,
// each leg bought back if it reaches (1 + SL) x its sale price (fill at the trigger, or at the worse open price on a gap), what is left is
// bought back at 15:00. One lot of 65, NSE option charges (STT 0.1% on sell value). Weekly expiry: Thursday to 28 Aug 2025, Tuesday after.
//   primary variants: SL 40% / slippage 1% (the author's), SL 30% / 1%, SL 40% / 2%, SL 30% / 2%, no stop / 1%
//   sensitivities (not part of the pass rule): volatility scale 0.83 and 1.03, calendar clock, STT 0.15%, slippage 0 / 0.5%
// Periods: development 2024-10 to 2026-03-31, holdout 2026-04-01 on. Margin per lot assumed Rs 2,00,000 for the % figures.
// PASS RULE: average net per day positive in BOTH periods, day-block sign-flip p below 0.05 after adjusting for the 5 primary variants,
// and the maximum drawdown no more than 25% of the margin (the author says 20-25% is fine).
const fs = require('fs');
const path = require('path');
const V = require('./lib/validate');
const { simulateDay, expiryFor } = require('./lib/straddle');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const dir = arg('dir', path.join('data', 'fyers-1m'));
const DEV_END = '2026-03-31', MARGIN = 200000, LOT = 65, SCALE = 0.93;
const IST = 5.5 * 3600e3, dayKey = ms => new Date(ms + IST).toISOString().slice(0, 10);

function load(file) {
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').slice(1), days = new Map();
  for (const l of rows) { const r = l.split(','), t = Date.parse(r[0]), k = dayKey(t); let d = days.get(k); if (!d) days.set(k, d = { t: [], O: [], H: [], L: [], C: [] }); d.t.push(t); d.O.push(+r[1]); d.H.push(+r[2]); d.L.push(+r[3]); d.C.push(+r[4]); }
  return days;
}
const nifty = load(path.join(dir, 'NIFTY.csv')), vixd = load(path.join(dir, 'INDIAVIX.csv'));
const cal = [...nifty.keys()].filter(d => nifty.get(d).t.length >= 370).sort();
const calSet = new Set(cal), last = cal[cal.length - 1];
console.log(`Nifty ${cal.length} sessions (${cal[0]} to ${last}); India VIX ${vixd.size} sessions\n`);

const remaining = (day, expiry) => { let n = cal.filter(d => d > day && d <= expiry).length; if (expiry > last) { for (let d = new Date(last + 'T00:00:00Z'); ; ) { d = new Date(d.getTime() + 86400e3); const s = d.toISOString().slice(0, 10); if (s > expiry) break; if (s > last && d.getUTCDay() % 6 !== 0) n++; } } return n; };

function run(p) {
  const out = [];
  for (const day of cal) {
    const m = nifty.get(day), v = vixd.get(day); if (!v || v.C.length < 300) continue;
    const mm = { t0: m.t[0], O: m.O, H: m.H, L: m.L, C: m.C };
    const expiry = expiryFor(day, calSet, last), r = simulateDay(mm, v.C, { ...p, expiry, remainingDays: remaining(day, expiry), lot: LOT });
    if (r) out.push({ day, expiry, isExpiryDay: day === expiry, ...r });
  }
  return out;
}

const f0 = v => Math.round(v).toLocaleString('en-IN'), sg = v => (v >= 0 ? '+' : '') + f0(v), pc = v => (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
function stats(rows) {
  const net = rows.map(r => r.net); let cum = 0, peak = 0, dd = 0, st = 0, ms = 0;
  for (const x of net) { cum += x; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); st = x > 0 ? 0 : st + 1; ms = Math.max(ms, st); }
  const months = {}; for (const r of rows) months[r.day.slice(0, 7)] = (months[r.day.slice(0, 7)] || 0) + r.net;
  const mv = Object.values(months), yrs = rows.length / 250;
  return { n: rows.length, win: rows.filter(r => r.net > 0).length / rows.length, avg: V.mean(net), total: cum, perYear: cum / yrs / MARGIN * 100, dd, ddPct: dd / MARGIN * 100, streak: ms, posMonths: mv.filter(x => x > 0).length, months: mv.length, worst: Math.min(...net), best: Math.max(...net), stopLegs: rows.reduce((a, r) => a + r.stops, 0) / (rows.length * 2) };
}
function line(label, rows) {
  const s = stats(rows), dev = rows.filter(r => r.day <= DEV_END), ho = rows.filter(r => r.day > DEV_END);
  console.log(`${label.padEnd(30)} days ${String(s.n).padStart(3)}  win ${(s.win * 100).toFixed(0).padStart(3)}%  avg Rs ${sg(s.avg).padStart(6)}/day  total Rs ${sg(s.total).padStart(8)} (${pc(s.perYear)} a year on Rs 2L)  max drawdown Rs ${f0(s.dd).padStart(7)} (${s.ddPct.toFixed(0)}%)  dev ${sg(V.mean(dev.map(r => r.net)))} | holdout ${sg(V.mean(ho.map(r => r.net)))}  legs stopped ${(s.stopLegs * 100).toFixed(0)}%`);
  return s;
}

const SL = { 'SL 40%, slip 1% (the author)': { slPct: 0.4, slip: 0.01 }, 'SL 30%, slip 1%': { slPct: 0.3, slip: 0.01 }, 'SL 40%, slip 2%': { slPct: 0.4, slip: 0.02 }, 'SL 30%, slip 2%': { slPct: 0.3, slip: 0.02 }, 'No stop, slip 1%': { slPct: null, slip: 0.01 } };
const base = { ivScale: SCALE, clock: 'trading', entryMin: 45, exitMin: 345, r: 0.065 };
console.log('PRIMARY VARIANTS (modelled option prices; costs and slippage included)');
const prim = {}; for (const [name, v] of Object.entries(SL)) { prim[name] = run({ ...base, ...v }); line(name, prim[name]); }

console.log('\nSENSITIVITY on the author\'s variant (SL 40%, slip 1%)');
const A = SL['SL 40%, slip 1% (the author)'];
for (const [label, extra] of [['volatility scale 0.83', { ivScale: 0.83 }], ['volatility scale 1.03', { ivScale: 1.03 }], ['calendar clock, scale 0.91', { clock: 'calendar', ivScale: 0.91 }], ['STT 0.15%', { stt: 0.0015 }], ['slippage 0%', { slip: 0 }], ['slippage 0.5%', { slip: 0.005 }], ['slippage 3%', { slip: 0.03 }]]) line(label, run({ ...base, ...A, ...extra }));

const au = prim['SL 40%, slip 1% (the author)'];
console.log('\nTHE AUTHOR\'S VARIANT IN DETAIL');
const by = {}; for (const r of au) { const k = r.isExpiryDay ? 'expiry day (0 days left)' : 'other days'; (by[k] = by[k] || []).push(r); }
for (const [k, rows] of Object.entries(by)) line('  ' + k, rows);
const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
for (let d = 1; d <= 5; d++) { const rows = au.filter(r => new Date(r.day + 'T00:00:00Z').getUTCDay() === d); if (rows.length) line('  ' + wd[d], rows); }
const yr = {}; for (const r of au) (yr[r.day.slice(0, 7)] = yr[r.day.slice(0, 7)] || []).push(r.net);
console.log('  net Rs by month: ' + Object.entries(yr).map(([k, v]) => k.slice(2) + ' ' + sg(v.reduce((a, b) => a + b, 0))).join(' | '));
const worst = au.slice().sort((a, b) => a.net - b.net).slice(0, 5);
console.log('  five worst days: ' + worst.map(r => `${r.day} ${sg(r.net)} (Nifty ${r.spot.toFixed(0)}, ${r.stops} leg stops${r.isExpiryDay ? ', expiry day' : ''})`).join(' | '));
console.log(`  average premium sold ${V.mean(au.map(r => r.entryPremium)).toFixed(0)} points per straddle; gross per day Rs ${sg(V.mean(au.map(r => r.gross)))}, charges Rs ${f0(V.mean(au.map(r => r.fee)))} per day`);

console.log('\nVERDICT (frozen rule)');
const verdicts = [];
for (const [name, rows] of Object.entries(prim)) {
  const dev = rows.filter(r => r.day <= DEV_END), ho = rows.filter(r => r.day > DEV_END), s = stats(rows);
  const sf = V.signFlipTest(rows.map(r => r.net), rows.map(r => r.day)), adj = V.sidak(sf.p, 5), bs = V.clusterBootstrap(ho.map(r => r.net), ho.map(r => r.day), { n: 2000 });
  const pass = V.mean(dev.map(r => r.net)) > 0 && V.mean(ho.map(r => r.net)) > 0 && adj < 0.05 && s.ddPct <= 25;
  verdicts.push(pass);
  console.log(`  ${name.padEnd(30)} sign-flip p ${sf.p.toFixed(4)} (adjusted ${adj.toFixed(4)}), holdout avg 95% range Rs ${sg(bs.meanLo)} to ${sg(bs.meanHi)} per day, max drawdown ${s.ddPct.toFixed(0)}%  ->  ${pass ? 'PASSES' : 'does not pass'}`);
}
console.log(`\n${verdicts.filter(Boolean).length} of ${verdicts.length} primary variants pass.`);
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/straddle-author.csv', 'day,expiry,expiryDay,strike,spot,premiumPts,points,gross,fee,net,legStops\n' + au.map(r => [r.day, r.expiry, r.isExpiryDay ? 1 : 0, r.K, r.spot.toFixed(1), r.entryPremium.toFixed(1), r.points.toFixed(2), r.gross.toFixed(0), r.fee.toFixed(0), r.net.toFixed(0), r.stops].join(',')).join('\n'));
