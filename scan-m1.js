// Current M1 (monthly 12-1 momentum) picks and regime, from the latest daily files. Paper-trading list only.
//   node scan-m1.js --dir data/fyers-daily
const fs = require('fs'), path = require('path');
const dir = (i => (i > 0 ? process.argv[i + 1] : 'data/fyers-daily'))(process.argv.indexOf('--dir'));
const S = {};
for (const f of fs.readdirSync(dir)) { if (!f.endsWith('.csv')) continue; const r = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').slice(1).map(l => l.split(',')); S[f.slice(0, -4)] = { d: r.map(x => x[0].slice(0, 10)), c: r.map(x => +x[4]), v: r.map(x => +x[5]), o: r.map(x => +x[1]) }; }
const N = S.NIFTY; delete S.NIFTY; delete S.INDIAVIX;
const n = N.c.length, sma200 = N.c.slice(n - 200).reduce((a, b) => a + b, 0) / 200;
console.log(`Data to ${N.d[n - 1]}. Nifty close ${N.c[n - 1].toFixed(0)}, 200-day average ${sma200.toFixed(0)} -> regime ${N.c[n - 1] > sma200 ? 'ON (buy allowed)' : 'OFF (stay in cash)'}`);
const rows = [];
for (const [sym, s] of Object.entries(S)) {
  const x = s.c.length; if (x < 260 || s.d[x - 1] !== N.d[n - 1]) continue;
  let turn = 0; for (let q = x - 20; q < x; q++) turn += s.c[q] * s.v[q]; turn /= 20;
  let art = false; for (let q = x - 252; q < x; q++) if (Math.abs(s.c[q] / s.c[q - 1] - 1) > 0.35) art = true;
  if (turn < 3e8 || s.c[x - 1] > 8000 || art) continue;
  rows.push({ sym, mom: s.c[x - 21] / s.c[x - 252] - 1, close: s.c[x - 1], turn });
}
rows.sort((a, b) => b.mom - a.mom);
console.log('Top 10 by 12-1 month momentum (equal weight, hold until the next monthly rebalance on the first session of November):');
rows.slice(0, 10).forEach((r, i) => console.log(`  ${String(i + 1).padStart(2)}. ${r.sym.padEnd(12)} momentum ${(r.mom * 100).toFixed(0)}%   last close ${r.close.toFixed(2)}`));
