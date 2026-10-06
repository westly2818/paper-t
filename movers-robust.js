// Is the "6% or more at 09:35" lead real, or an artefact? Uses the same 5-minute files and mover rules as movers-backfill.js.
//   node --max-old-space-size=6000 movers-robust.js --dir data/fyers-5m-long [--min 6]
// Checks: outliers (mean vs median, trimmed), huge moves that may be splits/demergers, direction, year, how many different stocks and
// days carry the result, then a tradable version: enter at the 09:35 close in the move direction, fixed stop, exit at 15:15 open.
// Return unit: percent of the 09:35 price in the move direction. Charges 0.14% round trip are subtracted where it says "net".
const fs = require('fs');
const path = require('path');
const base = require('./config');
const { sessionsOf, moverFeatures, COST_PCT } = require('./lib/movers');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const DIR = arg('dir', 'data/fyers-5m-long'), MIN = +arg('min', 6);
const K_REF = 3, K_1515 = 72;

function readBars(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n'), out = [];
  for (let i = 1; i < lines.length; i++) { const r = lines[i].split(','); if (r.length < 6) continue; out.push({ t: Date.parse(r[0]), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }); }
  return out;
}
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
const f = (v, d = 2) => (v == null || !isFinite(v) ? '-' : (v >= 0 ? '+' : '') + v.toFixed(d) + '%');

// the exit price with a fixed stop (percent against us, measured from the 09:35 close); a stop is assumed filled at its level
function trade(today, dir, ref, stopPct) {
  const stop = stopPct ? ref * (1 - dir * stopPct / 100) : null;
  for (let k = K_REF + 1; k < K_1515; k++) {
    const b = today[k]; if (!b) continue;
    if (stop != null && (dir === 1 ? b.l <= stop : b.h >= stop)) return dir * (stop / ref - 1) * 100;
  }
  const end = today[K_1515] ? today[K_1515].o : null;
  return end == null ? null : dir * (end / ref - 1) * 100;
}

const rows = [];
for (const file of fs.readdirSync(DIR).filter(x => x.endsWith('.csv') && !/^(NIFTY|INDIAVIX)\.csv$/.test(x))) {
  const sym = file.slice(0, -4), sess = sessionsOf(readBars(path.join(DIR, file)));
  for (const day of [...sess.keys()].sort()) {
    const feat = moverFeatures(sess, day);
    if (!feat || Math.abs(feat.movePct) < MIN || feat.turnover < base.minTurnover) continue;
    const today = sess.get(day); if (!today[K_REF] || !today[K_1515]) continue;
    const dir = feat.movePct >= 0 ? 1 : -1, ref = today[K_REF].c;
    rows.push({ day, sym, y: day.slice(0, 4), dir, move: feat.movePct, gap: feat.gapPct, rvol: feat.rvol, r0: trade(today, dir, ref, 0), r2: trade(today, dir, ref, 2), r3: trade(today, dir, ref, 3), r1: trade(today, dir, ref, 1) });
  }
}
const ok = rows.filter(r => r.r0 != null);

function line(name, a, key = 'r0') {
  const v = a.map(r => r[key]).filter(x => x != null); if (v.length < 5) { console.log(name.padEnd(34), 'n=' + v.length); return; }
  const days = new Map(); for (const r of a) { if (r[key] == null) continue; days.set(r.day, (days.get(r.day) || 0) + r[key] - COST_PCT); }
  const dv = [...days.values()], t = mean(dv) / (sd(dv) / Math.sqrt(dv.length));
  const sorted = v.slice().sort((x, y) => x - y), cut = Math.floor(v.length * 0.05), trimmed = mean(sorted.slice(cut, v.length - cut));
  console.log(`${name.padEnd(34)} n=${String(v.length).padStart(5)}  days ${String(days.size).padStart(4)}  mean ${f(mean(v)).padStart(7)}  median ${f(median(v)).padStart(7)}  trimmed5% ${f(trimmed).padStart(7)}  net ${f(mean(v) - COST_PCT).padStart(7)}  win ${(v.filter(x => x > COST_PCT).length / v.length * 100).toFixed(0)}%  t(day,net) ${t.toFixed(1)}`);
}

console.log(`${rows.length} movers of ${MIN}% or more (${ok.length} with a 15:15 price). Hold to 15:15, no stop:`);
line('all', ok);
line('move under 15%', ok.filter(r => Math.abs(r.move) < 15));
line('move under 25%', ok.filter(r => Math.abs(r.move) < 25));
line('move 15% or more', ok.filter(r => Math.abs(r.move) >= 15));
line('up-moves', ok.filter(r => r.dir === 1));
line('down-moves', ok.filter(r => r.dir === -1));
line('strong early volume (5x+)', ok.filter(r => r.rvol >= 5));
line('weaker early volume (under 5x)', ok.filter(r => r.rvol < 5));
line('mostly gap (gap > 70% of move)', ok.filter(r => Math.abs(r.gap) > 0.7 * Math.abs(r.move)));
line('built after the open', ok.filter(r => Math.abs(r.gap) <= 0.7 * Math.abs(r.move)));
console.log('\nBy year (move under 25%):');
for (const y of [...new Set(ok.map(r => r.y))].sort()) line(y, ok.filter(r => r.y === y && Math.abs(r.move) < 25));
console.log('\nConcentration: top stocks by number of cases, and the result without the biggest 5% of winners:');
const bySym = new Map(); for (const r of ok) bySym.set(r.sym, (bySym.get(r.sym) || 0) + 1);
console.log([...bySym.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([s, n]) => `${s} ${n}`).join(', '), ` (${bySym.size} different stocks)`);
const sorted = ok.map(r => r.r0).sort((a, b) => b - a), top = Math.ceil(sorted.length * 0.05);
console.log(`mean of all ${f(mean(sorted))}; mean without the top 5% of winners ${f(mean(sorted.slice(top)))}`);
console.log('\nTradable version, enter at the 09:35 close in the move direction (move under 25%):');
const sub = ok.filter(r => Math.abs(r.move) < 25);
line('no stop', sub, 'r0'); line('stop 3%', sub, 'r3'); line('stop 2%', sub, 'r2'); line('stop 1%', sub, 'r1');
fs.writeFileSync(path.join(__dirname, 'data', 'movers-robust.json'), JSON.stringify(rows));
