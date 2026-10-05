// Runs the momentum book's own rules (lib/momentum.js) over 10 years of Fyers daily data, as a check that the live
// code does what swing-study.js M1 did. Differences from the study: holdings that stay in the top N are kept
// (the study re-bought them every month), and the book rebalances equal-weight only for new entrants.
//   node momentum-sim.js --dir data/fyers-daily-10y [--slots 10] [--capital 50000]
// SURVIVORSHIP BIAS: the universe is today's Nifty 200 members, so every number here is optimistic.
const fs = require('fs');
const path = require('path');
const { momentumPicks, planOrders, executeOrders } = require('./lib/momentum');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const dir = arg('dir', 'data/fyers-daily-10y'), SLOTS = +arg('slots', 10), CAP = +arg('capital', 50000), DEV_END = '2022-12-31';

const S = {};
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.csv')) continue;
  const rows = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').slice(1).map(l => l.split(','));
  const d = rows.map(r => r[0].slice(0, 10));
  S[f.slice(0, -4)] = { d, o: rows.map(r => +r[1]), c: rows.map(r => +r[4]), v: rows.map(r => +r[5]), idx: new Map(d.map((x, i) => [x, i])) };
}
const N = S.NIFTY; delete S.NIFTY; delete S.INDIAVIX;
const cal = N.d;
const slice = (s, x) => ({ d: s.d.slice(0, x), c: s.c.slice(0, x), v: s.v.slice(0, x) });

// ---- today's list: must equal scan-m1.js ----
{
  const sl = {}; for (const [sym, s] of Object.entries(S)) sl[sym] = slice(s, s.c.length);
  const res = momentumPicks(sl, slice(N, N.c.length), SLOTS);
  console.log(`As of ${res.asOf}: Nifty ${res.niftyClose.toFixed(0)} vs 200-day average ${res.sma200.toFixed(0)} -> regime ${res.regimeOn ? 'ON' : 'OFF'}; ${res.eligibleCount} eligible`);
  console.log('Top ' + SLOTS + ': ' + res.picks.map(p => `${p.sym} ${(p.mom * 100).toFixed(0)}%`).join(', ') + '\n');
}

// ---- month by month ----
const book = { cash: CAP, positions: [] };
const curve = [];
let prevMonth = null, trades = 0, fees = 0, first = null;
for (let i = 0; i < cal.length; i++) {
  const day = cal[i], month = day.slice(0, 7);
  if (month !== prevMonth && i >= 260) {
    const sl = {}, open = {};
    for (const [sym, s] of Object.entries(S)) { const x = s.idx.get(day); if (x == null || x < 1) continue; sl[sym] = slice(s, x); open[sym] = s.o[x]; }
    const res = momentumPicks(sl, slice(N, i), SLOTS);
    const plan = planOrders(book.positions, res, SLOTS);
    const prices = {}; for (const o of [...plan.sells, ...plan.buys]) prices[o.sym] = open[o.sym];
    for (const p of book.positions) if (!(p.sym in prices)) prices[p.sym] = open[p.sym] || p.entry;
    if (plan.sells.every(o => prices[o.sym] > 0) && plan.buys.every(o => prices[o.sym] > 0)) {
      const t = executeOrders(book, plan, prices, SLOTS, day, 0);
      trades += t.filter(x => x.side !== 'SKIP').length; fees += t.reduce((a, x) => a + (x.fee || 0), 0);
    }
    if (!first) first = i;
  }
  prevMonth = month;
  if (first == null) continue;
  let eq = book.cash;
  for (const p of book.positions) { const s = S[p.sym], x = s.idx.get(day); eq += p.qty * (x != null ? s.c[x] : p.entry); }
  curve.push({ day, eq, nifty: N.c[i] });
}
const stats = (from, to) => {
  const c = curve.filter(p => p.day >= from && p.day <= to); if (c.length < 20) return 'n/a';
  let pk = 0, dd = 0; for (const p of c) { pk = Math.max(pk, p.eq); dd = Math.max(dd, 1 - p.eq / pk); }
  const yrs = (Date.parse(c[c.length - 1].day) - Date.parse(c[0].day)) / (365 * 86400000);
  const cagr = (Math.pow(c[c.length - 1].eq / c[0].eq, 1 / yrs) - 1) * 100, ncagr = (Math.pow(c[c.length - 1].nifty / c[0].nifty, 1 / yrs) - 1) * 100;
  const inCash = c.filter(p => Math.abs(p.eq - book.cash) < 1e-9).length;
  return `${from} to ${to}: book ${cagr.toFixed(1)}%/yr (max drawdown ${(dd * 100).toFixed(0)}%)  Nifty ${ncagr.toFixed(1)}%/yr`;
};
console.log(`Start ${cal[first]}, capital ${CAP}, ${SLOTS} slots. ${trades} trades, charges ${fees.toFixed(0)}, final value ${curve[curve.length - 1].eq.toFixed(0)}`);
console.log('  development ' + stats(cal[first], DEV_END));
console.log('  holdout     ' + stats('2023-01-01', cal[cal.length - 1]));
console.log('  whole       ' + stats(cal[first], cal[cal.length - 1]));
console.log('\n(swing-study.js M1, same data, re-buying every month: whole period 20.7%/yr with 33% drawdown; development 16.2%, holdout 27.2%.)');
