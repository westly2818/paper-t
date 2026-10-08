// Is this method really working, or is it just riding the market? Judges a method's live trades against what the SAME KIND of
// signal earned on ALL 200 stocks on the same day, and turns the result into a confidence number with an honest verdict.
//   node --env-file=.env db-sync.js           first: copies the newest trades and 5-minute archives into MongoDB
//   node decide.js                            V5 (default)
//   node decide.js --strategy orb             the day bot (opening-range breakout)
//   options: --min-score 60 (V5 only)  --since 2026-10-07  --all-entries (V5: count re-entries too)
// Benchmark: for each trade, the average net R of every lab signal with the same side (and, for V5, the same setup A/B/C and a
//   score at or above the threshold) on that day over all 200 stocks. For the day bot the benchmark is the lab's opening-breakout
//   setup A (close beyond the 15-minute range, right side of VWAP; its exits are a little different from the bot's), so treat the
//   day-bot reading as approximate. excess = the method's trade R - benchmark R.
// Confidence = P(true average excess > 0) from resampling whole DAYS. Gate, bands and the measured false-alarm rates live in
//   lib/decide.js (frozen). Read the false-alarm line: a reading of 60-75% appears about a third of the time with NO edge.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { MongoClient } = require('mongodb');
const V = require('./lib/validate');
const { judge, GATE, FALSE_ALARM } = require('./lib/decide');
const { build } = require('./lab-5m-from-archive');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const has = k => process.argv.includes('--' + k);
const STRATEGY = arg('strategy', 'v5'), SINCE = arg('since', null), FIRST_ONLY = !has('all-entries');
const MIN_SCORE = STRATEGY === 'orb' ? 0 : +arg('min-score', 60), FLAT = 0.3;
const IST = 5.5 * 3600e3, dayOf = ms => new Date(ms + IST).toISOString().slice(0, 10);
const LAB = path.join('data', 'lab-5m-recent');
const f2 = (v, d = 2) => (v == null || !isFinite(v) ? '-' : (v >= 0 && d !== 0 ? '+' : '') + v.toFixed(d));
const pct = x => (x * 100).toFixed(0) + '%';

(async () => {
  if (!['v5', 'orb'].includes(STRATEGY)) throw new Error('--strategy must be v5 or orb');
  const client = new MongoClient(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017', { serverSelectionTimeoutMS: 5000 }); await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'paper_trader');
  const key = STRATEGY === 'v5' ? 'paper-trader:v5:trades' : 'paper-trader:state:trades';
  const raw = (await db.collection('lists').find({ key }).sort({ idx: 1 }).toArray()).map(x => x.doc);
  const sync = (await db.collection('sync_log').find().sort({ _id: -1 }).limit(1).toArray())[0];
  await client.close();
  if (!raw.length) { console.log(`No ${STRATEGY} trades in MongoDB yet. Run: node --env-file=.env db-sync.js`); return; }
  console.log(`Method: ${STRATEGY === 'v5' ? 'Momentum V5' : 'Day bot (opening-range breakout)'}. MongoDB last synced ${sync ? sync.finished_at : 'never'}; ${raw.length} trades stored.`);

  let trades = STRATEGY === 'v5'
    ? raw.map(t => { const risk = Math.abs(t.entry - t.stop) * t.qty; return { day: dayOf(t.openedAt), sym: t.sym, dir: t.dir, setup: t.setup, opened: t.openedAt, net: t.netPnL, r: risk > 0 ? t.netPnL / risk : null }; })
    : raw.map(t => ({ day: t.day, sym: t.sym, dir: t.side === 'long' ? 1 : -1, setup: 'A', opened: t.tIn, net: t.net, r: t.rMultiple }));
  trades = trades.filter(t => t.r != null && isFinite(t.r) && (!SINCE || t.day >= SINCE)).sort((a, b) => a.opened - b.opened);
  if (FIRST_ONLY) { const seen = new Set(); trades = trades.filter(t => { const k = t.day + t.sym; if (seen.has(k)) return false; seen.add(k); return true; }); }
  if (!trades.length) { console.log('Nothing to judge after the filters.'); return; }
  const first = trades[0].day;

  await build({ out: LAB, history: fs.existsSync(path.join('data', 'fyers-1m')) ? path.join('data', 'fyers-1m') : null, log: () => {} });
  execFileSync(process.execPath, ['--max-old-space-size=3000', 'intraday-lab.js', '--dir', LAB, '--from', first], { stdio: 'ignore' });
  const lab = JSON.parse(fs.readFileSync(path.join('data', `intraday-lab-from-${first}.json`), 'utf8')).filter(r => r.score >= MIN_SCORE);
  const bench = (day, dir, setup) => {
    const a = lab.filter(r => r.day === day && r.dir === dir && r.s === setup);
    if (a.length >= 5) return V.mean(a.map(x => x.r));
    const b = lab.filter(r => r.day === day && r.dir === dir);
    return b.length >= 5 ? V.mean(b.map(x => x.r)) : null;
  };
  const closes = new Map();
  for (const l of fs.readFileSync(path.join(LAB, 'NIFTY.csv'), 'utf8').trim().split('\n').slice(1)) { const r = l.split(','); closes.set(dayOf(Date.parse(r[0])), +r[4]); }
  const nd = [...closes.keys()].sort(), move = d => { const i = nd.indexOf(d); return i > 0 ? (closes.get(d) / closes.get(nd[i - 1]) - 1) * 100 : null; };
  const kind = d => { const m = move(d); return m == null ? '?' : m > FLAT ? 'up' : m < -FLAT ? 'down' : 'flat'; };

  const rows = []; let skipped = 0;
  for (const t of trades) { const b = bench(t.day, t.dir, t.setup); if (b == null) { skipped++; continue; } rows.push({ ...t, bench: b, excess: t.r - b, kind: kind(t.day) }); }
  if (!rows.length) { console.log('No trade has a benchmark yet (the 5-minute archive for those days is missing). Run db-sync.js.'); return; }

  console.log(`\nTrades judged against the same-day all-stock benchmark${STRATEGY === 'v5' ? ` (score >= ${MIN_SCORE}; ${FIRST_ONLY ? 'first trade per stock per day' : 'every entry'})` : ''}`);
  console.log('day         Nifty    kind   trades   method avg R   benchmark R   excess');
  for (const d of [...new Set(rows.map(r => r.day))]) {
    const a = rows.filter(r => r.day === d), m = move(d);
    console.log(`${d}  ${(m == null ? '-' : f2(m, 2) + '%').padStart(7)}  ${kind(d).padEnd(5)}  ${String(a.length).padStart(6)}   ${f2(V.mean(a.map(r => r.r))).padStart(12)}   ${f2(V.mean(a.map(r => r.bench))).padStart(11)}   ${f2(V.mean(a.map(r => r.excess))).padStart(7)}`);
  }
  const j = judge(rows);
  console.log(`\n${j.n} trades on ${j.days} days${skipped ? ` (${skipped} without a benchmark)` : ''}. Up days ${j.up}, down days ${j.down}, flat ${j.flat}.`);
  console.log(`  win rate             ${pct(j.winRate)}   (profit needs roughly 50% at a 1.5R target after charges; a high win rate alone proves nothing)`);
  console.log(`  average R            ${f2(j.raw.mean, 3)}R   95% range ${f2(j.raw.meanLo, 3)} to ${f2(j.raw.meanHi, 3)}`);
  console.log(`  average benchmark R  ${f2(V.mean(rows.map(r => r.bench)), 3)}R`);
  console.log(`  average EXCESS       ${f2(j.excess.mean, 3)}R   95% range ${f2(j.excess.meanLo, 3)} to ${f2(j.excess.meanHi, 3)}`);
  for (const k of ['up', 'down']) { const a = rows.filter(r => r.kind === k); if (a.length) console.log(`    on ${k.padEnd(4)} days: ${String(a.length).padStart(3)} trades, method ${f2(V.mean(a.map(r => r.r)))}R, benchmark ${f2(V.mean(a.map(r => r.bench)))}R, excess ${f2(V.mean(a.map(r => r.excess)))}R`); }
  console.log(`\nConfidence that the method beats the all-stock benchmark: ${pct(j.confidence)}`);
  console.log(`  How much to trust a reading: with NO real edge a method still reads 60% or more about ${pct(FALSE_ALARM[0.6])} of the time, 75% or more about ${pct(FALSE_ALARM[0.75])}, 90% or more about ${pct(FALSE_ALARM[0.9])}.`);
  if (!j.gateOk) {
    console.log(`VERDICT: TOO EARLY. The gate needs ${GATE.trades} trades on ${GATE.days} days with ${GATE.up} up and ${GATE.down} down days; still missing: ${j.missing.join(', ')}.`);
    console.log(`         If the gate were met today the reading would be: ${j.band}. Do not act on it yet.`);
  } else {
    console.log(`VERDICT: ${j.band}`);
    console.log('  For real money, do not rely on 60-75%. Wait for 90% or more, a reading that stays there on two separate months, and a still-positive average after charges.');
  }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
