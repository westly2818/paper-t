// Is there anything to scalp? Very short holds on 1-minute bars, 12 months, NIFTY plus 20 liquid stocks.
//   node scalp-lab.js [--dir data/fyers-1m]
// Two fixed ideas (parameters chosen before the first run, nothing tuned):
//   BURST  a 1-minute candle closes beyond the previous 10-minute high/low and its volume is 2x the 20-candle average (stocks only; the index has no volume,
//          so for NIFTY the size of the candle must be 2x its 20-candle average range). Enter at the next open in that direction, stop 0.15%, target 0.25%, exit after 10 minutes.
//   FADE   price is 0.30% or more away from the day's VWAP (stocks only), enter at the next open toward the VWAP, stop 0.20% further away, target the VWAP, exit after 15 minutes.
// One trade per symbol at a time, none before 09:30 or after 15:00. Stop assumed first when a minute touches both. Entry at the next candle's open.
// Result in percent of price per trade: gross, and after costs of 0.14% (what the day bot assumes), 0.06% (optimistic: very low slippage) and, for NIFTY, 0.03%.
const fs = require('fs');
const path = require('path');
const { dayKey, minOfDay } = require('./lib/time');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const DIR = arg('dir', 'data/fyers-1m');
const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);

function read(file) {
  return fs.readFileSync(file, 'utf8').split('\n').slice(1).filter(Boolean).map(l => { const r = l.split(','); return { t: Date.parse(r[0]), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }; });
}
function exitTrade(bars, i, dir, stopPct, tgtFn, maxMin) {   // i = signal bar; enter at bars[i+1].o
  const e = bars[i + 1]; if (!e) return null;
  const entry = e.o, stop = entry * (1 - dir * stopPct / 100);
  const tgt = tgtFn(entry);
  for (let j = i + 1; j <= i + maxMin && j < bars.length; j++) {
    const b = bars[j]; if (dayKey(b.t) !== dayKey(e.t)) break;
    if (dir === 1 ? b.l <= stop : b.h >= stop) return { r: -stopPct, end: j };
    if (tgt != null && (dir === 1 ? b.h >= tgt : b.l <= tgt)) return { r: dir * (tgt / entry - 1) * 100, end: j };
  }
  const j = Math.min(i + maxMin, bars.length - 1); if (dayKey(bars[j].t) !== dayKey(e.t)) return null;
  return { r: dir * (bars[j].c / entry - 1) * 100, end: j };
}

const all = { BURST: [], FADE: [] };
for (const f of fs.readdirSync(DIR).filter(x => x.endsWith('.csv'))) {
  const sym = f.slice(0, -4), bars = read(path.join(DIR, f)), isIdx = sym === 'NIFTY';
  let busyUntil = -1, vwapDay = null, pv = 0, vv = 0;
  for (let i = 25; i < bars.length - 20; i++) {
    const b = bars[i], d = dayKey(b.t), m = minOfDay(b.t);
    if (d !== vwapDay) { vwapDay = d; pv = 0; vv = 0; }
    pv += (b.h + b.l + b.c) / 3 * b.v; vv += b.v;
    if (m < 9 * 60 + 30 || m > 15 * 60 || i <= busyUntil || dayKey(bars[i - 12].t) !== d) continue;
    const vwap = vv ? pv / vv : null;
    // BURST
    let hi = -1e18, lo = 1e18, av = 0, ar = 0;
    for (let j = i - 10; j < i; j++) { hi = Math.max(hi, bars[j].h); lo = Math.min(lo, bars[j].l); }
    for (let j = i - 20; j < i; j++) { av += bars[j].v; ar += bars[j].h - bars[j].l; }
    av /= 20; ar /= 20;
    const big = isIdx ? (b.h - b.l) >= 2 * ar : b.v >= 2 * av && av > 0;
    if (big && (b.c > hi || b.c < lo)) {
      const dir = b.c > hi ? 1 : -1, t = exitTrade(bars, i, dir, 0.15, e => e * (1 + dir * 0.25 / 100), 10);
      if (t) { all.BURST.push({ sym, day: d, r: t.r, idx: isIdx, y: d.slice(0, 7) }); busyUntil = t.end; continue; }
    }
    // FADE (stocks only)
    if (!isIdx && vwap && m >= 10 * 60) {
      const dev = (b.c / vwap - 1) * 100;
      if (Math.abs(dev) >= 0.3) {
        const dir = dev > 0 ? -1 : 1, t = exitTrade(bars, i, dir, 0.20, () => vwap, 15);
        if (t) { all.FADE.push({ sym, day: d, r: t.r, idx: false, y: d.slice(0, 7) }); busyUntil = t.end; }
      }
    }
  }
}

function report(name, a) {
  if (a.length < 20) { console.log(name.padEnd(26), 'n=' + a.length); return; }
  const costs = a[0].idx ? [0, 0.03] : [0, 0.06, 0.14];
  const byDay = new Map(); for (const x of a) { const v = byDay.get(x.day) || []; v.push(x.r); byDay.set(x.day, v); }
  const parts = costs.map(c => { const dm = [...byDay.values()].map(v => mean(v) - c), m = mean(dm), sd = Math.sqrt(mean(dm.map(x => (x - m) ** 2))); return `${c === 0 ? 'gross' : 'net@' + c + '%'} ${(mean(a.map(x => x.r)) - c >= 0 ? '+' : '') + (mean(a.map(x => x.r)) - c).toFixed(3)}% (t ${(m / (sd / Math.sqrt(dm.length) || 1)).toFixed(1)})`; });
  console.log(`${name.padEnd(26)} trades ${String(a.length).padStart(6)}  win ${(a.filter(x => x.r > 0).length / a.length * 100).toFixed(0)}%  ` + parts.join('   '));
}
console.log(`1-minute bars from ${DIR}. Percent of price per trade.\n`);
report('BURST stocks', all.BURST.filter(x => !x.idx)); report('BURST NIFTY', all.BURST.filter(x => x.idx)); report('FADE-to-VWAP stocks', all.FADE);
const halves = a => { const ms = [...new Set(a.map(x => x.y))].sort(); const mid = ms[Math.floor(ms.length / 2)]; return [a.filter(x => x.y < mid), a.filter(x => x.y >= mid)]; };
for (const [n, a] of [['BURST stocks', all.BURST.filter(x => !x.idx)], ['FADE-to-VWAP stocks', all.FADE]]) { const [h1, h2] = halves(a); report('  ' + n + ' first half', h1); report('  ' + n + ' second half', h2); }
