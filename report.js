// Evaluation report for the frozen strategy, from the permanent trade log.
//   node --env-file=.env report.js                 (reads Upstash Redis)
//   node report.js --dir data                      (reads data/trades.jsonl, local mode)
//   node report.js --dir <folder> --version 3      (only one strategy version)
// Do not change rules because of the first 30 sessions: 30 = preliminary, 50 = meaningful, 100+ = strong.
const fs = require('fs');
const path = require('path');
const { dayKey } = require('./lib/time');

const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : null; };

async function load() {
  const dir = arg('dir');
  if (dir) {
    const f = path.join(dir, 'trades.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
  }
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url) throw new Error('Set UPSTASH_REDIS_REST_URL/TOKEN (use --env-file=.env) or pass --dir <folder>');
  const key = (process.env.STATE_KEY || 'paper-trader:state') + ':trades';
  const res = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: JSON.stringify(['LRANGE', key, 0, -1]) });
  const j = await res.json();
  if (j.error) throw new Error(j.error);
  return j.result.map(JSON.parse);
}

const f1 = (n, d = 2) => (n == null || !isFinite(n) ? '-' : n.toFixed(d));

function report(label, trades, sessionsWithData) {
  const n = trades.length;
  if (!n) { console.log(`\n${label}: no trades yet`); return; }
  trades = trades.slice().sort((a, b) => a.tOut - b.tOut);
  const wins = trades.filter(t => t.net > 0), losses = trades.filter(t => t.net <= 0);
  const gw = wins.reduce((a, t) => a + t.net, 0), gl = -losses.reduce((a, t) => a + t.net, 0);
  let cum = 0, peak = 0, dd = 0, streak = 0, maxStreak = 0;
  for (const t of trades) {
    cum += t.net; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum);
    streak = t.net > 0 ? 0 : streak + 1; maxStreak = Math.max(maxStreak, streak);
  }
  const totalR = trades.reduce((a, t) => a + t.rMultiple, 0);
  const sessions = new Set(trades.map(t => t.day)).size;
  const side = s => { const a = trades.filter(t => t.side === s); return a.length ? `${a.length} trades, ${f1(a.filter(t => t.net > 0).length / a.length * 100, 0)}% wins, ${f1(a.reduce((x, t) => x + t.rMultiple, 0) / a.length)}R avg, net ${f1(a.reduce((x, t) => x + t.net, 0), 0)}` : 'none'; };
  const hit2R = trades.filter(t => /Target/.test(t.exitReason)).length;
  const sq = trades.filter(t => /Square-off/.test(t.exitReason)).length;
  const stage = sessionsWithData >= 100 ? 'strong evidence' : sessionsWithData >= 50 ? 'meaningful evaluation' : sessionsWithData >= 30 ? 'preliminary check only' : 'too early, do not change anything';
  console.log(`\n${label}`);
  console.log(`  Sessions with trades: ${sessions} (${stage})`);
  console.log(`  Trades ${n}   Win% ${f1(wins.length / n * 100, 0)}   Avg R ${f1(totalR / n)}   Total R ${f1(totalR, 1)}   Profit factor ${gl > 0 ? f1(gw / gl) : 'inf'}`);
  console.log(`  Net after charges ${f1(trades.reduce((a, t) => a + t.net, 0), 0)}   Charges ${f1(trades.reduce((a, t) => a + t.fees, 0), 0)}   Max drawdown ${f1(dd, 0)}   Longest loss streak ${maxStreak}`);
  console.log(`  Avg win ${f1(gw / (wins.length || 1), 0)}   Avg loss ${f1(-gl / (losses.length || 1), 0)}   Avg hold ${f1(trades.reduce((a, t) => a + (t.minutesHeld || 0), 0) / n, 0)} min`);
  console.log(`  2R target hit: ${hit2R}/${n} (${f1(hit2R / n * 100, 0)}%)   15:15 square-off exits: ${sq}/${n}`);
  console.log(`  Long : ${side('long')}`);
  console.log(`  Short: ${side('short')}`);
  // Confidence score at entry (High 75+, Medium 50-74, Low under 50): does a higher score mean better trades?
  const conf = trades.filter(t => t.ctx && t.ctx.confidence);
  if (conf.length >= 5) {
    console.log(`  By confidence at entry (${conf.length} trades have it):`);
    for (const [name, lo, hi] of [['High (75 and above)', 75, 101], ['Medium (50 to 74)', 50, 75], ['Low (under 50)', 0, 50]]) {
      const b = conf.filter(t => t.ctx.confidence.score >= lo && t.ctx.confidence.score < hi);
      if (b.length) console.log(`    ${name.padEnd(22)} ${b.length} trades, ${f1(b.filter(t => t.net > 0).length / b.length * 100, 0)}% wins, ${f1(b.reduce((x, t) => x + t.rMultiple, 0) / b.length)}R avg, net ${f1(b.reduce((x, t) => x + t.net, 0), 0)}`);
    }
  }
}

(async () => {
  let trades = await load();
  const v = arg('version');
  if (v) trades = trades.filter(t => String(t.strategyVersion) === v);
  // Records can be logged twice after a crash: keep one per day + id.
  const seen = new Set();
  trades = trades.filter(t => { const k = t.day + ':' + t.id; if (seen.has(k)) return false; seen.add(k); return true; });
  const versions = [...new Set(trades.map(t => String(t.strategyVersion)))].sort();
  console.log(`${trades.length} trades logged, strategy versions: ${versions.join(', ') || 'none'}`);
  for (const ver of versions) {
    const t = trades.filter(x => String(x.strategyVersion) === ver);
    report(`Strategy version ${ver}`, t, new Set(t.map(x => x.day)).size);
  }
})().catch(e => { console.error(e.message); process.exit(1); });
