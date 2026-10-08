// Longer holds on NIFTY: what does the day do after a gap, and after a failed break of the previous-day high/low? (not scalping: 1 to 6 hours)
//   node nifty-gaps.js [--dir data/fyers-5m-long]
// Market move in percent of price from the 09:30 open (bar 3) to four horizons, grouped by the opening gap (open vs previous close), then two fixed setups:
//   FAILED-UP    gap up, opened above the previous-day high, but the candle closing at 09:55 is back below it  -> short from the 09:55 open
//   FAILED-DOWN  gap down, opened below the previous-day low, but the candle closing at 09:55 is back above it -> long from the 09:55 open
//   GAP-HELD     gap of 0.5% or more and the candle closing at 09:50 is still on the gap side of the open and of the previous close -> trade WITH the gap from the 09:50 open
// (An earlier version measured these from the 09:30 open, which counted the move that created the signal: look-ahead. Fixed: each setup is measured from the first open after its signal.)
// Splits fixed first: development to 2023, validation 2024, out-of-sample 2025 onward. Round-trip cost 0.03% (futures-like). No stops: pure direction check.
const fs = require('fs');
const path = require('path');
const { sessionsOf } = require('./lib/movers');

const DIR = (() => { const i = process.argv.indexOf('--dir'); return i > 0 ? process.argv[i + 1] : 'data/fyers-5m-long'; })();
const COST = 0.03;
const bars = fs.readFileSync(path.join(DIR, 'NIFTY.csv'), 'utf8').split('\n').slice(1).filter(Boolean).map(l => { const r = l.split(','); return { t: Date.parse(r[0]), o: +r[1], h: +r[2], l: +r[3], c: +r[4] }; });
const sess = sessionsOf(bars), days = [...sess.keys()].sort();
const HZ = [['10:30', 14], ['12:00', 32], ['13:30', 50], ['15:15', 72]];     // bar index of the open at that time
const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);

const rows = [];
for (let i = 1; i < days.length; i++) {
  const a = sess.get(days[i]), p = sess.get(days[i - 1]);
  if (a.filter(Boolean).length < 70 || p.filter(Boolean).length < 70 || !a[3] || !a[0]) continue;
  const pb = p.filter(Boolean), hi = Math.max(...pb.map(b => b.h)), lo = Math.min(...pb.map(b => b.l)), pc = pb[pb.length - 1].c;
  const gap = (a[0].o / pc - 1) * 100, e = a[3].o, mv = {};
  for (const [n, k] of HZ) mv[n] = a[k] ? (a[k].o / e - 1) * 100 : null;
  rows.push({ day: days[i], gap, hi, lo, pc, a, e, mv });
}
const split = r => (r.day <= '2023-12-31' ? 'dev' : r.day <= '2024-12-31' ? 'val' : 'oos');
function cell(set, f) {
  if (set.length < 12) return `n=${String(set.length).padStart(4)}       -        `;
  const v = set.map(f).filter(x => x != null), m = mean(v), sd = Math.sqrt(mean(v.map(x => (x - m) ** 2)));
  return `n=${String(v.length).padStart(4)} ${(m >= 0 ? '+' : '') + m.toFixed(3)}% t${(m / (sd / Math.sqrt(v.length))).toFixed(1).padStart(5)}`;
}
const HK = Object.fromEntries(HZ);
function show(name, set, sign, hz, k0 = 3) {   // sign: +1 market direction, or function(r) for a trade direction; k0 = entry bar (its open)
  const f = r => { const d = typeof sign === 'function' ? sign(r) : sign; const x = r.a[k0], y = r.a[HK[hz]]; return !x || !y ? null : d * (y.o / x.o - 1) * 100 - COST; };
  console.log(`${name.padEnd(34)} dev ${cell(set.filter(r => split(r) === 'dev'), f)} | val ${cell(set.filter(r => split(r) === 'val'), f)} | oos ${cell(set.filter(r => split(r) === 'oos'), f)}`);
}
console.log(`NIFTY ${days[0]} to ${days[days.length - 1]}, ${rows.length} sessions. Mean move per trade in % of price after ${COST}% cost, t on days.\n`);

console.log('A. Gap buckets: trade WITH the gap (sign of the gap), at each horizon');
const buckets = [['gap < -1%', r => r.gap < -1], ['-1% to -0.5%', r => r.gap >= -1 && r.gap < -0.5], ['-0.5% to -0.25%', r => r.gap >= -0.5 && r.gap < -0.25], ['flat +-0.25%', r => Math.abs(r.gap) < 0.25], ['0.25% to 0.5%', r => r.gap >= 0.25 && r.gap < 0.5], ['0.5% to 1%', r => r.gap >= 0.5 && r.gap < 1], ['gap > +1%', r => r.gap >= 1]];
for (const [hn] of HZ) { console.log(' -- to ' + hn); for (const [n, f] of buckets.filter(b => b[0] !== 'flat +-0.25%')) show('  with gap: ' + n, rows.filter(f), r => Math.sign(r.gap), hn); }

console.log('\nB. Failed breakouts and held gaps (hold to each horizon)');
const failUp = rows.filter(r => r.gap > 0 && r.a[0].o > r.hi && r.a[7] && r.a[7].c < r.hi);          // bar 7 = the 09:50 candle, which closes at 09:55; entry is the next open (bar 8)
const failDn = rows.filter(r => r.gap < 0 && r.a[0].o < r.lo && r.a[7] && r.a[7].c > r.lo);
const held = rows.filter(r => Math.abs(r.gap) >= 0.5 && r.a[6] && Math.sign(r.a[6].c - r.a[0].o) === Math.sign(r.gap) && Math.sign(r.a[6].c - r.pc) === Math.sign(r.gap));
for (const [hn] of HZ.slice(1)) {
  console.log(' -- to ' + hn);
  show('  FAILED-UP -> short', failUp, -1, hn, 8); show('  FAILED-DOWN -> long', failDn, 1, hn, 8); show('  GAP-HELD -> with the gap', held, r => Math.sign(r.gap), hn, 7);
}
console.log('\nPlateau check for GAP-HELD (to 15:15): the result should not depend on the exact threshold');
for (const th of [0.3, 0.4, 0.5, 0.7, 1.0]) {
  const s = rows.filter(r => Math.abs(r.gap) >= th && r.a[6] && Math.sign(r.a[6].c - r.a[0].o) === Math.sign(r.gap) && Math.sign(r.a[6].c - r.pc) === Math.sign(r.gap));
  show('  |gap| >= ' + th + '%', s, r => Math.sign(r.gap), '15:15', 7);
}
