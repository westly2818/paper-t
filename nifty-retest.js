// "Breakout + retest" on the NIFTY index itself, from the pasted F&O routine. Tests the SIGNAL on the underlying (no option prices here:
// there is no history for expired option contracts), so it shows whether the direction call has an edge before theta and spreads.
//   node nifty-retest.js [--dir data/fyers-5m-long] [--level pdhl|or] [--window 30] [--rr 2]
// Rules (fixed before the first run):
//   levels      previous-day high (long) and previous-day low (short); --level or uses the 09:15-09:30 range instead
//   breakout    a 5-minute candle closes beyond the level, at or after 09:30
//   retest      within the next 12 candles a candle trades back to within 0.03% of the level (its low <= level*1.0003 for longs)
//   confirm     the next candle closes back beyond the level in the trade direction (green for long, red for short): signal; entry = next candle's open
//   stop        the extreme of the breakout-to-confirmation candles, clamped to 0.12%-0.40% of price; target = rr x stop; flat at 15:15
//   window      signals only until bar number --window (30 = 11:45); one trade per day, first signal either side
//   "no retest" variant: enter on the next open after the breakout close (the beginner version the text warns against)
// Cost: 0.03% of price per round trip (futures-like; option buying costs more). R values are shown gross and net of that.
const fs = require('fs');
const path = require('path');
const { sessionsOf } = require('./lib/movers');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const DIR = arg('dir', 'data/fyers-5m-long'), LEVEL = arg('level', 'pdhl'), WINDOW = +arg('window', 30), RR = +arg('rr', 2), COST = 0.03, MIN = 0.12, MAX = 0.40;

const lines = fs.readFileSync(path.join(DIR, 'NIFTY.csv'), 'utf8').split('\n').slice(1).filter(Boolean);
const bars = lines.map(l => { const r = l.split(','); return { t: Date.parse(r[0]), o: +r[1], h: +r[2], l: +r[3], c: +r[4] }; });
const sess = sessionsOf(bars), days = [...sess.keys()].sort();

function walk(a, k, dir, stopRaw) {            // signal bar k closed; enter at a[k+1].o
  const e = a[k + 1]; if (!e) return null;
  const entry = e.o;
  let d = Math.abs(entry - stopRaw) / entry * 100; if (dir === 1 ? stopRaw >= entry : stopRaw <= entry) d = MAX;
  d = Math.max(MIN, Math.min(MAX, d));
  const stop = entry * (1 - dir * d / 100), tp = entry * (1 + dir * RR * d / 100);
  for (let j = k + 1; j < 72; j++) {
    const b = a[j]; if (!b) continue;
    if (dir === 1 ? b.l <= stop : b.h >= stop) return { r: -1, d };
    if (dir === 1 ? b.h >= tp : b.l <= tp) return { r: RR, d };
  }
  const x = a[72] ? a[72].o : null; if (x == null) return null;
  return { r: dir * (x / entry - 1) * 100 / d, d };
}

function run(retest) {
  const out = [];
  for (let i = 1; i < days.length; i++) {
    const a = sess.get(days[i]), p = sess.get(days[i - 1]);
    if (a.filter(Boolean).length < 70 || p.filter(Boolean).length < 70) continue;
    let hi, lo;
    if (LEVEL === 'or') { const o = [a[0], a[1], a[2]]; hi = Math.max(...o.map(b => b.h)); lo = Math.min(...o.map(b => b.l)); }
    else { const pb = p.filter(Boolean); hi = Math.max(...pb.map(b => b.h)); lo = Math.min(...pb.map(b => b.l)); }
    let trade = null;
    for (let k = 3; k <= WINDOW && !trade; k++) {
      const b = a[k]; if (!b || !a[k + 1]) continue;
      for (const dir of [1, -1]) {
        const lvl = dir === 1 ? hi : lo;
        if (dir === 1 ? b.c <= lvl : b.c >= lvl) continue;
        // a breakout candle: it must be the first close beyond the level today
        let first = true; for (let j = 3; j < k; j++) if (a[j] && (dir === 1 ? a[j].c > lvl : a[j].c < lvl)) { first = false; break; }
        if (!first) continue;
        if (!retest) { trade = { dir, r: walk(a, k, dir, dir === 1 ? b.l : b.h), day: days[i] }; break; }
        let ext = dir === 1 ? b.l : b.h, touched = false;
        for (let j = k + 1; j <= Math.min(k + 12, 70) && !trade; j++) {
          const c = a[j]; if (!c || !a[j + 1]) continue;
          ext = dir === 1 ? Math.min(ext, c.l) : Math.max(ext, c.h);
          if (!touched) { if (dir === 1 ? c.l <= lvl * 1.0003 : c.h >= lvl * 0.9997) touched = true; else continue; }
          if (dir === 1 ? c.c > lvl && c.c > c.o : c.c < lvl && c.c < c.o) { trade = { dir, r: walk(a, j, dir, ext), day: days[i] }; }
          else if (dir === 1 ? c.c < lvl * 0.9985 : c.c > lvl * 1.0015) break;   // failed back through the level: give up
        }
        if (trade) break;
      }
    }
    if (trade && trade.r) out.push({ day: trade.day, dir: trade.dir, r: trade.r.r, d: trade.r.d });
  }
  return out;
}

const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
function show(name, t) {
  if (!t.length) { console.log(name, 'no trades'); return; }
  const net = t.map(x => x.r - COST / x.d), m = mean(net), sd = Math.sqrt(mean(net.map(x => (x - m) ** 2)));
  const w = t.filter(x => x.r > 0).length;
  console.log(`${name.padEnd(34)} trades ${String(t.length).padStart(4)} (${(t.length / (days.length - 1) * 100).toFixed(0)}% of days)  win ${(w / t.length * 100).toFixed(0)}%  gross ${mean(t.map(x => x.r)).toFixed(3)}R  net ${m.toFixed(3)}R  t ${(m / (sd / Math.sqrt(t.length))).toFixed(1)}  avg stop ${mean(t.map(x => x.d)).toFixed(2)}%`);
}
console.log(`NIFTY 5-min, ${days[0]} to ${days[days.length - 1]} (${days.length} sessions), levels ${LEVEL}, signals until bar ${WINDOW}, target ${RR}R, stop ${MIN}-${MAX}%, cost ${COST}%`);
const rt = run(true), nr = run(false);
show('breakout + retest (all)', rt); show('  long only', rt.filter(x => x.dir === 1)); show('  short only', rt.filter(x => x.dir === -1));
show('  up to 2022', rt.filter(x => x.day <= '2022-12-31')); show('  2023 onward', rt.filter(x => x.day > '2022-12-31'));
show('no retest, enter at breakout (all)', nr); show('  long only', nr.filter(x => x.dir === 1)); show('  short only', nr.filter(x => x.dir === -1));
for (const y of [...new Set(rt.map(x => x.day.slice(0, 4)))].sort()) show('  retest ' + y, rt.filter(x => x.day.startsWith(y)));
