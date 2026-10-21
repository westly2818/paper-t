// One-command review of every paper book. Built for the one-month review (about 8 Nov 2026) and safe to run any day.
//   node --env-file=.env review.js [--since 2026-10-09]      prints the report and saves it to data/review-<today>.txt
// Rules for reading it are fixed HERE, before the results are known (change them only with a note in docs/STUDY-GUIDE.md):
//   V5 counts as a candidate for a very small real-money test only if ALL of these hold on trades since --since (default 9 Oct, the no-re-entry rule):
//     at least 100 trades, average R after charges AND after the cautious stop-slippage estimate >= +0.10, day-clustered t >= 2,
//     and at least 60% of the calendar weeks positive after slippage. Otherwise the answer is "keep paper trading".
//   The day bot needs about 370 trades before any verdict (see the sample-size table in the study guide); below that this report only describes it.
// R after charges: V5 uses rNet (or netPnL / risk for older records); the day bot's rMultiple is already after charges.
const fs = require('fs');
const path = require('path');

const GATE = { minTrades: 100, minAvgR: 0.10, minT: 2, minGoodWeeks: 0.6 };
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const SINCE = arg('since', '2026-10-09');
const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
if (!url) { console.error('Run with: node --env-file=.env review.js'); process.exit(1); }
const call = async cmd => { const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: JSON.stringify(cmd) }); const j = await r.json(); if (j.error) throw new Error(j.error); return j.result; };
const D = ms => new Date(ms + 19800000).toISOString().slice(0, 10);
const H = ms => { const d = new Date(ms + 19800000); return d.getUTCHours() + d.getUTCMinutes() / 60; };
const f = (n, d = 2) => (n >= 0 ? '+' : '') + n.toFixed(d);
const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const lines = [];
const out = s => { lines.push(s); console.log(s); };

function tstat(byDay) {   // t of the daily average, one number per day
  const v = [...byDay.values()].map(mean); if (v.length < 3) return null;
  const m = mean(v), sd = Math.sqrt(mean(v.map(x => (x - m) ** 2)) * v.length / (v.length - 1));
  return sd > 0 ? m / (sd / Math.sqrt(v.length)) : null;
}
const isoWeek = day => { const d = new Date(day + 'T00:00:00Z'); const t = new Date(Date.UTC(d.getUTCFullYear(), 0, 1)); return d.getUTCFullYear() + '-W' + String(Math.floor(((d - t) / 86400000 + t.getUTCDay()) / 7)).padStart(2, '0'); };

(async () => {
  out(`REVIEW of the paper books, run ${D(Date.now())} (IST). V5 and day-bot rows count trades from ${SINCE}.\n`);

  // ---------------- V5 ----------------
  const v5 = JSON.parse(await call(['GET', 'paper-trader:v5:state']));
  const all = v5.closed.map(t => {
    const risk = t.qty * t.entry * (t.stopPct / 100), slip = t.exitReason === 'stop' ? 0.25 * risk : 0;
    return { ...t, day: D(t.closedAt), hr: H(Number(t.id.split('-').pop())), risk, rNetC: t.rNet != null ? t.rNet : t.netPnL / risk, netSlip: t.netPnLSlip != null ? t.netPnLSlip : t.netPnL - slip, rSlip: (t.netPnLSlip != null ? t.netPnLSlip : t.netPnL - slip) / risk };
  });
  const c = all.filter(t => t.day >= SINCE);
  out(`=== V5 momentum: ${all.length} trades in total, ${c.length} since ${SINCE}`);
  if (c.length) {
    const byDay = new Map(); for (const t of c) { if (!byDay.has(t.day)) byDay.set(t.day, []); byDay.get(t.day).push(t); }
    out('  per day: ' + [...byDay.entries()].map(([d, a]) => `${d.slice(5)} ${a.length}tr ${f(a.reduce((x, t) => x + t.netPnL, 0), 0)}`).join(' | '));
    const w = c.filter(t => t.netPnL > 0).length, ts = tstat(new Map([...byDay.entries()].map(([d, a]) => [d, a.map(t => t.rSlip)])));
    const weeks = new Map(); for (const t of c) { const k = isoWeek(t.day); weeks.set(k, (weeks.get(k) || 0) + t.netSlip); }
    const goodWeeks = [...weeks.values()].filter(x => x > 0).length / weeks.size;
    out(`  trades ${c.length}, wins ${w} (${(w / c.length * 100).toFixed(0)}%), net ${f(c.reduce((a, t) => a + t.netPnL, 0), 0)} Rs, after the cautious stop-slippage estimate ${f(c.reduce((a, t) => a + t.netSlip, 0), 0)} Rs, charges ${c.reduce((a, t) => a + t.charges, 0).toFixed(0)} Rs`);
    out(`  average R: before charges ${f(mean(c.map(t => t.r)))}, after charges ${f(mean(c.map(t => t.rNetC)))}, after charges and slippage ${f(mean(c.map(t => t.rSlip)))}   (the 8-year lab said about -0.11 to -0.19 after charges)`);
    out(`  day-clustered t (after slippage) ${ts == null ? 'n/a (fewer than 3 days)' : ts.toFixed(2)}, positive weeks ${(goodWeeks * 100).toFixed(0)}% of ${weeks.size}`);
    const row = (n, a) => { if (a.length) out(`    ${n.padEnd(22)} ${String(a.length).padStart(3)} trades  win ${(a.filter(t => t.netPnL > 0).length / a.length * 100).toFixed(0).padStart(3)}%  avg R after charges+slip ${f(mean(a.map(t => t.rSlip))).padStart(6)}  net ${f(a.reduce((x, t) => x + t.netSlip, 0), 0)}`); };
    out('  by setup and side:'); for (const s of ['A', 'B', 'C']) for (const L of ['BUY', 'SELL']) row(`${s} ${L === 'BUY' ? 'long' : 'short'}`, c.filter(t => t.setup === s && t.side === L));
    out('  by entry time:'); for (const [n, lo, hi] of [['09:30-10:00', 9.5, 10], ['10:00-10:30', 10, 10.5], ['10:30-13:30', 10.5, 13.5], ['13:30-14:45', 13.5, 15]]) row(n, c.filter(t => t.hr >= lo && t.hr < hi));
    out('  by score:'); for (const [n, lo, hi] of [['60-75', 60, 75], ['75-85', 75, 85], ['85+', 85, 101]]) row('score ' + n, c.filter(t => t.score >= lo && t.score < hi));
    out('  by relative-strength points:'); row('RS 20 or more', c.filter(t => t.parts && t.parts.relativeStrength >= 20)); row('RS below 20', c.filter(t => t.parts && t.parts.relativeStrength < 20));
    const checks = [[`at least ${GATE.minTrades} trades (has ${c.length})`, c.length >= GATE.minTrades], [`avg R after charges and slippage >= ${GATE.minAvgR} (is ${f(mean(c.map(t => t.rSlip)))})`, mean(c.map(t => t.rSlip)) >= GATE.minAvgR], [`day-clustered t >= ${GATE.minT} (is ${ts == null ? 'n/a' : ts.toFixed(2)})`, ts != null && ts >= GATE.minT], [`positive weeks >= ${GATE.minGoodWeeks * 100}% (is ${(goodWeeks * 100).toFixed(0)}%)`, goodWeeks >= GATE.minGoodWeeks]];
    out('  GATE for a very small real-money test:'); for (const [n, ok] of checks) out(`    [${ok ? 'x' : ' '}] ${n}`);
    out('  VERDICT: ' + (checks.every(x => x[1]) ? 'all conditions met: a candidate for a very small real test. Still paper-only until you decide.' : 'not yet. Keep paper trading.'));
  }

  // ---------------- day bot ----------------
  const seen = new Set();
  const orb = (await call(['LRANGE', 'paper-trader:state:trades', 0, -1])).map(JSON.parse).filter(t => { const k = t.day + ':' + t.id; if (seen.has(k)) return false; seen.add(k); return true; }).filter(t => t.day >= '2026-10-01');
  out(`\n=== Day bot (opening range): ${orb.length} logged trades`);
  if (orb.length) {
    const w = orb.filter(t => t.net > 0).length;
    out(`  wins ${w} (${(w / orb.length * 100).toFixed(0)}%), average R after charges ${f(mean(orb.map(t => t.rMultiple)))}, net ${f(orb.reduce((a, t) => a + t.net, 0), 0)} Rs, charges ${orb.reduce((a, t) => a + t.fees, 0).toFixed(0)} Rs   (replay: about -0.12R)`);
    for (const s of ['long', 'short']) { const a = orb.filter(t => t.side === s); if (a.length) out(`    ${s}: ${a.length} trades, avg R ${f(mean(a.map(t => t.rMultiple)))}, net ${f(a.reduce((x, t) => x + t.net, 0), 0)}`); }
    out(`  VERDICT: ${orb.length < 370 ? `${orb.length} trades is far below the ~370 needed. Describes only, no verdict.` : 'enough trades to judge: compare with the replay number above.'}`);
  }

  // ---------------- F&O ----------------
  try {
    const fno = JSON.parse(await call(['GET', 'paper-trader:fno:state']));
    out(`\n=== F&O weekly NIFTY iron condor: closed ${fno.closed.length}, open ${fno.pos ? 1 : 0}, option-chain snapshots saved ${fno.snaps}`);
    for (const k of fno.closed.slice(0, 8)) out(`    ${k.expiry}: credit ${k.credit.toFixed(1)} pts, net ${f(k.net, 0)} Rs (${f(k.r)} of the worst case), ${k.reason}`);
    if (fno.pos) out(`    open: ${fno.pos.expiry}, credit ${fno.pos.credit.toFixed(1)} pts, mark-to-market ${f(fno.pos.mtm || 0, 0)} Rs, stop at -${Math.round(fno.pos.stopLoss)} Rs`);
    out('  VERDICT: a few weeks cannot judge a strategy whose risk is a rare large loss. Check that the stop worked and the data (chains) is complete.');
  } catch (e) { out('\n=== F&O: no data (' + e.message + ')'); }

  // ---------------- swing and movers ----------------
  try { const sw = JSON.parse(await call(['GET', 'paper-trader:mbook:state'])); out(`\n=== Swing book: ${(sw.positions || []).length} positions, cash ${Math.round(sw.cash || 0)} Rs (it holds cash while Nifty is below its 200-day average)`); } catch (e) { out('\n=== Swing book: no data'); }
  try { const n = await call(['LLEN', 'paper-trader:movers:scans']); const o = await call(['LLEN', 'paper-trader:movers:outcomes']); out(`=== Mover scanner: ${n} scan records, ${o} outcome records (study only; see the 6%+ gap-down question in the study guide)`); } catch (e) { /* none */ }

  out('\nReading rules: judge by R, not rupees (positions can exceed the paper capital in collect-everything mode). 8 Oct V5 trades used the old re-entry rule, hence --since 9 Oct.');
  fs.mkdirSync('data', { recursive: true });
  const file = path.join('data', `review-${D(Date.now())}.txt`);
  fs.writeFileSync(file, lines.join('\n')); console.log('\nSaved to ' + file);
})().catch(e => { console.error('REVIEW ERROR', e.message); process.exit(1); });
