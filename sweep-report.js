// Compares the settings sweep (ranking-test.js runs named sw_*) against the baseline run sw_base, on the same sessions.
//   node sweep-report.js
// For each variant: trades, win %, average R per trade (net of charges), net rupees, profit factor, then the PAIRED comparison with the
// baseline: the difference in net rupees per session, its t-statistic across sessions, and whether the variant beat the baseline in
// BOTH years. With 13 variants, a few will look good by luck alone, so "promising" needs t >= 2.5 and both years.
const fs = require('fs');
const path = require('path');
const D = path.join(__dirname, 'data');
const names = fs.readdirSync(D).filter(n => /^ranking-sw_/.test(n)).map(n => n.replace('ranking-sw_', '')).filter(n => fs.existsSync(path.join(D, 'ranking-sw_' + n, 'summary.json')));
const load = n => ({ sum: JSON.parse(fs.readFileSync(path.join(D, 'ranking-sw_' + n, 'summary.json'), 'utf8')), trades: fs.readFileSync(path.join(D, 'ranking-sw_' + n, 'trades.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse) });
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
const tstat = a => (a.length > 3 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : 0);
const f = (x, d = 2) => (x == null || !isFinite(x) ? '-' : Number(x).toFixed(d));
const MID = '2025-10-01';
if (!names.includes('base')) { console.log('Baseline run sw_base is not finished yet. Finished so far: ' + names.join(', ')); process.exit(); }

const R = Object.fromEntries(names.map(n => [n, load(n)]));
const base = R.base, baseDay = new Map(base.sum.perDay.map(d => [d.day, d.net]));
const stat = r => {
  const tr = r.trades, rs = tr.map(t => t.rMultiple), gw = tr.filter(t => t.net > 0).reduce((a, t) => a + t.net, 0), gl = -tr.filter(t => t.net <= 0).reduce((a, t) => a + t.net, 0);
  const y = (lo, hi) => tr.filter(t => t.day >= lo && t.day < hi);
  return { n: tr.length, win: tr.filter(t => t.net > 0).length / Math.max(1, tr.length) * 100, avgR: mean(rs), t: tstat(rs), net: tr.reduce((a, t) => a + t.net, 0), pf: gl > 0 ? gw / gl : 0, y1: y('0', MID), y2: y(MID, '9') };
};
console.log(`Settings sweep: ${base.sum.sum.sessions} sessions (${base.sum.perDay[0].day} to ${base.sum.perDay[base.sum.perDay.length - 1].day}), shortlist 6, real engine, no news filter, charges included.`);
console.log('Baseline = the current live rules (entries to 10:30, breakeven at +0.5R, volume 0.9x, Nifty filter on, 2R target, trailing on).\n');
console.log('variant      trades  win%   avgR     t     net Rs    PF | net yr1 / yr2 | vs baseline: Rs/session   t   better in both years | verdict');
const order = ['base', 'e1000', 'e1130', 'e1430', 'be10', 'be025', 'rr15', 'rr3', 'nonifty', 'vol075', 'vol12', 'conf85', 'notrail', 'longonly'].filter(n => R[n]);
for (const n of order) {
  const s = stat(R[n]), net1 = s.y1.reduce((a, t) => a + t.net, 0), net2 = s.y2.reduce((a, t) => a + t.net, 0);
  let cmp = '', verdict = '';
  if (n !== 'base') {
    const diffs = R[n].sum.perDay.map(d => d.net - (baseDay.get(d.day) || 0));
    const dY1 = R[n].sum.perDay.filter(d => d.day < MID).map(d => d.net - (baseDay.get(d.day) || 0)), dY2 = R[n].sum.perDay.filter(d => d.day >= MID).map(d => d.net - (baseDay.get(d.day) || 0));
    const t = tstat(diffs), both = mean(dY1) > 0 && mean(dY2) > 0;
    cmp = `${f(mean(diffs)).padStart(8)} ${f(t, 1).padStart(6)}   ${both ? 'yes' : 'no '}`.padEnd(32);
    verdict = t >= 2.5 && both ? 'PROMISING' : t <= -2 ? 'worse' : both ? 'slightly better, not proven' : 'no clear difference';
    if (verdict === 'PROMISING' && s.net > 0 && net1 > 0 && net2 > 0) verdict += ' (profitable in both years)';
  } else cmp = ''.padEnd(32);
  console.log(`${n.padEnd(11)} ${String(s.n).padStart(6)} ${f(s.win, 0).padStart(4)}% ${f(s.avgR).padStart(6)} ${f(s.t, 1).padStart(5)} ${f(s.net, 0).padStart(9)} ${f(s.pf).padStart(5)} | ${f(net1, 0).padStart(6)} / ${f(net2, 0).padStart(6)} | ${cmp}| ${verdict}`);
}

// ----- extra reading from the runs themselves -----
const bucket = (trs, label, fn) => { const b = trs.filter(fn); if (b.length) console.log(`  ${label.padEnd(30)} n=${String(b.length).padStart(4)}  avg R ${f(mean(b.map(t => t.rMultiple)), 3).padStart(7)}  win ${f(b.filter(t => t.net > 0).length / b.length * 100, 0)}%  net Rs ${f(b.reduce((a, t) => a + t.net, 0), 0)}`); };
if (R.e1430) {
  console.log('\nWhen do entries work? (the all-day run, entries until 14:30, by the time the trade was entered):');
  const m = t => t.ctx.minuteOfDay;
  bucket(R.e1430.trades, '9:30 to 10:00', t => m(t) <= 600);
  bucket(R.e1430.trades, '10:00 to 10:30', t => m(t) > 600 && m(t) <= 630);
  bucket(R.e1430.trades, '10:30 to 11:30', t => m(t) > 630 && m(t) <= 690);
  bucket(R.e1430.trades, '11:30 to 12:30', t => m(t) > 690 && m(t) <= 750);
  bucket(R.e1430.trades, '12:30 to 14:30', t => m(t) > 750);
}
console.log('\nLong versus short (baseline run):');
bucket(base.trades, 'long', t => t.side === 'long'); bucket(base.trades, 'short', t => t.side === 'short');
const withConf = base.trades.filter(t => t.ctx && t.ctx.confidence);
if (withConf.length > 50) {
  console.log('\nBy the setup\'s confidence score at entry (baseline run):');
  bucket(withConf, 'High (75 and above)', t => t.ctx.confidence.score >= 75); bucket(withConf, 'Medium (50 to 74)', t => t.ctx.confidence.score >= 50 && t.ctx.confidence.score < 75);
  bucket(withConf, 'score 90 and above', t => t.ctx.confidence.score >= 90); bucket(withConf, 'score under 80', t => t.ctx.confidence.score < 80);
}
console.log('\nMissing so far: ' + ['base', 'e1000', 'e1130', 'e1430', 'be10', 'be025', 'rr15', 'rr3', 'nonifty', 'vol075', 'vol12', 'conf85', 'notrail', 'longonly'].filter(n => !R[n]).join(', ') || 'none');
