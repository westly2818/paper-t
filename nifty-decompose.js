// Why do NIFTY previous-day-level trades lose, and is there a condition where they do not? (follow-up to nifty-retest.js)
//   node nifty-decompose.js [--dir data/fyers-5m-long]
// For every session and each previous-day level (high, low) the FIRST 5-minute close beyond the level (09:35-14:30) is an event. Two trades per event:
//   CONT  continuation: enter at the next open in the break direction, stop = the break candle's far extreme
//   FADE  failure:      if within 12 candles a candle closes back inside the level, enter at the next open AGAINST the break, stop = extreme of the excursion
// Stops are clamped to 0.12%-0.40% of price, flat at 15:15, cost 0.03% of price, one result per event and trade type.
// Splits fixed before running: development 2018-10..2023-12, validation 2024, out-of-sample 2025-10 onward is NOT used for choosing anything.
// Groups (fixed list, not tuned): trade type x direction; gap size; time of day; attempt number at the level; VIX band; previous-day range band; target size.
// The index has no volume in this data, so VWAP and volume splits are not possible here.
const fs = require('fs');
const path = require('path');
const { sessionsOf } = require('./lib/movers');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const DIR = arg('dir', 'data/fyers-5m-long'), COST = 0.03, MIN = 0.12, MAX = 0.40, RRS = [1, 1.5, 2, 3];
const rd = f => fs.readFileSync(path.join(DIR, f), 'utf8').split('\n').slice(1).filter(Boolean).map(l => { const r = l.split(','); return { t: Date.parse(r[0]), o: +r[1], h: +r[2], l: +r[3], c: +r[4] }; });
const sess = sessionsOf(rd('NIFTY.csv')), days = [...sess.keys()].sort();
const vix = new Map(fs.readFileSync(path.join('data', 'fyers-daily-10y', 'INDIAVIX.csv'), 'utf8').split('\n').slice(1).filter(Boolean).map(l => { const r = l.split(','); return [r[0].slice(0, 10), +r[4]]; }));

function path1(a, k, dir, stopRaw) {   // returns { d, res: {rr: R}, mfe }
  const e = a[k + 1]; if (!e) return null;
  const entry = e.o;
  let d = Math.abs(entry - stopRaw) / entry * 100; if (dir === 1 ? stopRaw >= entry : stopRaw <= entry) d = MAX;
  d = Math.max(MIN, Math.min(MAX, d));
  const stop = entry * (1 - dir * d / 100);
  let mfe = 0, stopped = false; const reached = {};
  for (let j = k + 1; j < 72; j++) {
    const b = a[j]; if (!b) continue;
    if (dir === 1 ? b.l <= stop : b.h >= stop) { stopped = true; break; }
    const fav = dir === 1 ? (b.h / entry - 1) * 100 / d : (1 - b.l / entry) * 100 / d;
    mfe = Math.max(mfe, fav); for (const rr of RRS) if (reached[rr] == null && fav >= rr) reached[rr] = true;
  }
  const end = a[72] ? dir * (a[72].o / entry - 1) * 100 / d : null;
  if (!stopped && end == null) return null;
  const res = {}; for (const rr of RRS) res[rr] = reached[rr] ? rr : stopped ? -1 : end;
  return { d, res, mfe };
}

const events = [];
for (let i = 1; i < days.length; i++) {
  const a = sess.get(days[i]), p = sess.get(days[i - 1]);
  if (a.filter(Boolean).length < 70 || p.filter(Boolean).length < 70) continue;
  const pb = p.filter(Boolean), hi = Math.max(...pb.map(b => b.h)), lo = Math.min(...pb.map(b => b.l)), pc = pb[pb.length - 1].c;
  const gap = (a[0].o / pc - 1) * 100, prange = (hi - lo) / pc * 100, v = vix.get(days[i - 1]) || null;
  for (const dir of [1, -1]) {
    const lvl = dir === 1 ? hi : lo;
    // attempts: excursions beyond the level (by close) that came back inside before this event
    let attempts = 0, inside = true, k = 3;
    for (; k <= 66; k++) {
      const b = a[k]; if (!b) continue;
      const beyond = dir === 1 ? b.c > lvl : b.c < lvl;
      if (beyond && inside) { attempts++; if (k >= 3) break; }
      inside = !beyond;
    }
    const b = a[k]; if (!b || k > 66 || !a[k + 1]) continue;
    const base = { day: days[i], dir, gap, v, prange, k, attempt: attempts };
    const cont = path1(a, k, dir, dir === 1 ? b.l : b.h);
    if (cont) events.push({ ...base, type: 'CONT', ...cont });
    // fade: first close back inside within 12 candles
    let ext = dir === 1 ? b.h : b.l;
    for (let j = k + 1; j <= Math.min(k + 12, 70); j++) {
      const c = a[j]; if (!c || !a[j + 1]) continue;
      ext = dir === 1 ? Math.max(ext, c.h) : Math.min(ext, c.l);
      if (dir === 1 ? c.c < lvl : c.c > lvl) { const f = path1(a, j, -dir, ext); if (f) events.push({ ...base, type: 'FADE', dir: -dir, k: j, ...f }); break; }
    }
  }
}

const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const net = (e, rr) => e.res[rr] - COST / e.d;
const split = e => (e.day <= '2023-12-31' ? 'dev' : e.day <= '2024-12-31' ? 'val' : 'oos');
function line(name, set, rr = 2) {
  const cell = s => { const a = set.filter(e => split(e) === s); if (a.length < 15) return `n=${String(a.length).padStart(4)}      -     `; return `n=${String(a.length).padStart(4)} ${(mean(a.map(e => net(e, rr))) >= 0 ? '+' : '') + mean(a.map(e => net(e, rr))).toFixed(3)}R`; };
  console.log(`${name.padEnd(30)} dev ${cell('dev')}   val ${cell('val')}   oos ${cell('oos')}`);
}
console.log(`events ${events.length} over ${days.length} sessions. Net R after ${COST}% cost, target 2R unless stated. dev = to 2023, val = 2024, oos = 2025 onward.\n`);
const H = (t) => console.log('\n' + t);
H('1. Trade type x direction (CONT = with the break, FADE = against a failed break)');
for (const t of ['CONT', 'FADE']) for (const d of [1, -1]) line(`${t} ${d === 1 ? 'long' : 'short'}`, events.filter(e => e.type === t && e.dir === d));
H('2. Gap at the open (signed %, up = positive)');
for (const [n, f] of [['gap down > 0.5%', e => e.gap < -0.5], ['gap down 0.15-0.5%', e => e.gap >= -0.5 && e.gap < -0.15], ['flat (+-0.15%)', e => Math.abs(e.gap) <= 0.15], ['gap up 0.15-0.5%', e => e.gap > 0.15 && e.gap <= 0.5], ['gap up > 0.5%', e => e.gap > 0.5]]) for (const t of ['CONT', 'FADE']) line(`${t}, ${n}`, events.filter(e => e.type === t && f(e)));
H('3. Time of the break');
for (const [n, lo, hi] of [['09:35-10:00', 3, 9], ['10:00-11:00', 10, 21], ['11:00-13:00', 22, 45], ['13:00-14:30', 46, 66]]) for (const t of ['CONT', 'FADE']) line(`${t}, ${n}`, events.filter(e => e.type === t && e.k >= lo && e.k <= hi));
H('4. Attempt number at the level (1 = first time today beyond it)');
for (const [n, f] of [['1st', e => e.attempt === 1], ['2nd or later', e => e.attempt >= 2]]) for (const t of ['CONT', 'FADE']) line(`${t}, ${n} attempt`, events.filter(e => e.type === t && f(e)));
H('5. India VIX (previous close)');
for (const [n, f] of [['VIX < 13', e => e.v && e.v < 13], ['VIX 13-17', e => e.v && e.v >= 13 && e.v < 17], ['VIX 17+', e => e.v && e.v >= 17]]) for (const t of ['CONT', 'FADE']) line(`${t}, ${n}`, events.filter(e => e.type === t && f(e)));
H('6. Previous-day range');
for (const [n, f] of [['range < 0.8%', e => e.prange < 0.8], ['0.8-1.3%', e => e.prange >= 0.8 && e.prange < 1.3], ['1.3%+', e => e.prange >= 1.3]]) for (const t of ['CONT', 'FADE']) line(`${t}, ${n}`, events.filter(e => e.type === t && f(e)));
H('7. Target size (all CONT / all FADE) and how far trades run (share reaching X R before the stop)');
for (const rr of RRS) for (const t of ['CONT', 'FADE']) line(`${t}, target ${rr}R`, events.filter(e => e.type === t), rr);
for (const t of ['CONT', 'FADE']) { const a = events.filter(e => e.type === t); console.log(`${t}: reached 1R ${(a.filter(e => e.mfe >= 1).length / a.length * 100).toFixed(0)}%, 1.5R ${(a.filter(e => e.mfe >= 1.5).length / a.length * 100).toFixed(0)}%, 2R ${(a.filter(e => e.mfe >= 2).length / a.length * 100).toFixed(0)}%, 3R ${(a.filter(e => e.mfe >= 3).length / a.length * 100).toFixed(0)}% (random-walk break-even for 2R is 33%)`); }
// ---- the one bucket that was positive in all three periods: how solid is it? (a look, not a selection step)
{
  const a = events.filter(e => e.type === 'CONT' && e.k >= 46 && e.k <= 66).map(e => ({ e, r: net(e, 2) }));
  const m = mean(a.map(x => x.r)), sd = Math.sqrt(mean(a.map(x => (x.r - m) ** 2)));
  console.log(`\nCONT break between 13:00 and 14:30: n=${a.length}, net ${m.toFixed(3)}R, t ${(m / (sd / Math.sqrt(a.length))).toFixed(1)}, wins ${(a.filter(x => x.r > 0).length / a.length * 100).toFixed(0)}%, ` + ['long', 'short'].map(s => { const b = a.filter(x => x.e.dir === (s === 'long' ? 1 : -1)); return `${s} n=${b.length} ${mean(b.map(x => x.r)).toFixed(3)}R`; }).join(', '));
  const years = [...new Set(a.map(x => x.e.day.slice(0, 4)))].sort(); console.log('by year: ' + years.map(y => { const b = a.filter(x => x.e.day.startsWith(y)); return `${y} n=${b.length} ${mean(b.map(x => x.r)).toFixed(2)}`; }).join(' | '));
  console.log('Buckets looked at above: about 40. With 40 buckets, two or three will look positive by chance alone, so this needs fresh data (live logging) before anyone trusts it.');
}
