// Is this trade list better than chance? Reads a CSV or JSON of trades and prints the checks from lib/validate.js.
//   node validate-trades.js --file data/engine-bt-baseline.csv                 (uses the rMultiple column, days from the day column)
//   node validate-trades.js --file data/research-S1.csv --col net               (any numeric column)
//   node validate-trades.js --file data/live-export/trades.json --col rMultiple
//   options: --tests N  number of variants you tried before picking this one (adjusts the p-value, default 1)
//            --from YYYY-MM-DD --to YYYY-MM-DD   only trades in that period
const fs = require('fs');
const V = require('./lib/validate');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const file = arg('file');
if (!file) { console.error('Usage: node validate-trades.js --file <csv|json> [--col rMultiple] [--tests N] [--from D] [--to D]'); process.exit(1); }

function load(f) {
  if (f.endsWith('.json')) { const a = JSON.parse(fs.readFileSync(f, 'utf8')); return a; }
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n'), head = lines[0].split(',');
  return lines.slice(1).map(l => { const c = l.split(','); return Object.fromEntries(head.map((h, i) => [h.trim(), c[i]])); });
}
let rows = load(file);
const col = arg('col', rows[0] && rows[0].rMultiple !== undefined ? 'rMultiple' : rows[0] && rows[0].r !== undefined ? 'r' : 'net');
const from = arg('from'), to = arg('to'), tests = +arg('tests', 1);
rows = rows.filter(r => (!from || r.day >= from) && (!to || r.day <= to)).filter(r => isFinite(+r[col]));
if (rows.length < 8) { console.log(`Only ${rows.length} usable trades in ${file}: too few to test anything.`); process.exit(0); }
rows.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
const values = rows.map(r => +r[col]), days = rows.map(r => r.day);
const f = (v, d = 2) => (v == null || !isFinite(v) ? '-' : v.toFixed(d));
const unit = col === 'net' ? ' (rupees)' : col === 'ret' ? ' (fraction)' : 'R';

const bs = V.clusterBootstrap(values, days), sf = V.signFlipTest(values, days), wf = V.walkForward(values, 4), dd = V.drawdownShuffle(values);
console.log(`${file}  column "${col}"  ${rows.length} trades on ${bs.clusters} days (${rows[0].day} to ${rows[rows.length - 1].day})\n`);
console.log(`Average per trade      ${f(bs.mean, 3)}${unit}   95% range ${f(bs.meanLo, 3)} to ${f(bs.meanHi, 3)}   (days resampled as blocks)`);
console.log(`Profit factor          ${f(bs.pf)}   95% range ${f(bs.pfLo)} to ${f(bs.pfHi)}`);
console.log(`Chance the average is above zero (bootstrap)   ${f(bs.probMeanAboveZero * 100, 0)}%`);
const padj = V.sidak(sf.p, tests);
console.log(`Sign-flip test for an edge above zero          p = ${f(sf.p, 4)}${tests > 1 ? `   adjusted for ${tests} variants tried: p = ${f(padj, 4)}` : ''}`);
console.log(`Walk-forward, 4 consecutive slices: ${wf.windows.map(w => `${f(w.mean, 3)} (n=${w.n})`).join(' | ')}   positive slices ${wf.positive} of ${wf.total}`);
console.log(`Worst drawdown ${f(dd.observed, 2)}; same trades in random order: median ${f(dd.median, 2)}, 95th percentile ${f(dd.p95, 2)} (${f(dd.shareAsBad * 100, 0)}% of random orders were as bad)`);
const verdict = padj < 0.05 && bs.meanLo > 0 ? 'EDGE LIKELY: average is above zero by more than chance'
  : bs.meanHi < 0 ? 'LOSING: the whole 95% range is below zero'
  : 'NOT PROVEN: the 95% range includes zero, so chance cannot be ruled out';
console.log(`\nVerdict: ${verdict}`);
if (rows.length < 100) console.log(`Note: ${rows.length} trades is a small sample; ranges this wide rarely settle anything.`);
