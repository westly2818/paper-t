// Shadow test: would moving the stop to breakeven at +1R (instead of V3's +0.5R) have done better?
// Replays every logged trade on the saved 1-minute candles with the engine's exit rules, once with
// breakeven at +0.5R (should match the real result) and once at +1R. Gross R, no charges.
//   node --env-file=.env be-shadow.js              (Upstash Redis)
//   node be-shadow.js --dir data                   (local folder with trades.jsonl and candles-*.json.gz)
//   node be-shadow.js --dir <folder> --version 3
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : null; };
const dir = arg('dir');
const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
const key = process.env.STATE_KEY || 'paper-trader:state';
const redis = async cmd => {
  const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: JSON.stringify(cmd) });
  const j = await r.json(); if (j.error) throw new Error(j.error); return j.result;
};
const IST = 5.5 * 3600e3, mod = ms => { const d = new Date(ms + IST); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const SQ = 15 * 60 + 15, SLIP = 0.0002, RR = 2, TRAIL_R = 1.5;
const r05 = x => Math.round(x * 20) / 20;

async function loadTrades() {
  if (dir) { const f = path.join(dir, 'trades.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []; }
  if (!url) throw new Error('Set UPSTASH_REDIS_REST_URL/TOKEN (use --env-file=.env) or pass --dir <folder>');
  return (await redis(['LRANGE', key + ':trades', 0, -1])).map(JSON.parse);
}
const cache = {};
async function loadCandles(day) {
  if (cache[day] !== undefined) return cache[day];
  let gz = null;
  if (dir) { const f = path.join(dir, `candles-${day}.json.gz`); gz = fs.existsSync(f) ? fs.readFileSync(f) : null; }
  else { const b = await redis(['GET', `${key}:candles:${day}`]); gz = b && Buffer.from(b, 'base64'); }
  return (cache[day] = gz ? JSON.parse(zlib.gunzipSync(gz)) : null);
}

// Same order as the engine: check the candle against the stop and target, then move the stop.
function replay(t, m1, beR) {
  const d = t.side === 'long' ? 1 : -1, R = t.riskPerShare;
  let sl = t.stopInitial, best = t.entry;
  for (const k of m1) {
    if (k[0] < t.tIn) continue;
    if (mod(k[0]) >= SQ) return { r: ((k[1] * (1 - d * SLIP) - t.entry) * d) / R, why: 'square-off' };
    const [o, h, l] = [k[1], k[2], k[3]];
    if (d === 1 ? o <= sl : o >= sl) return { r: ((o * (1 - d * SLIP) - t.entry) * d) / R, why: 'stop' };
    if (d === 1 ? l <= sl : h >= sl) return { r: ((sl * (1 - d * SLIP) - t.entry) * d) / R, why: 'stop' };
    if (d === 1 ? h >= t.target : l <= t.target) return { r: ((t.target - t.entry) * d) / R, why: 'target' };
    best = d === 1 ? Math.max(best, h) : Math.min(best, l);
    const g = ((best - t.entry) * d) / R;
    let ns = sl;
    if (g >= beR) ns = d === 1 ? Math.max(ns, t.entry) : Math.min(ns, t.entry);
    if (g >= TRAIL_R) ns = d === 1 ? Math.max(ns, best - R) : Math.min(ns, best + R);
    ns = r05(ns);
    if (d === 1 ? ns > sl : ns < sl) sl = ns;
  }
  const k = m1[m1.length - 1];
  return { r: ((k[4] - t.entry) * d) / R, why: 'data end' };
}

(async () => {
  let trades = await loadTrades();
  const v = arg('version');
  if (v) trades = trades.filter(t => String(t.strategyVersion) === v);
  const seen = new Set();
  trades = trades.filter(t => { const k = t.day + ':' + t.id; if (seen.has(k)) return false; seen.add(k); return true; });
  const rows = [];
  for (const t of trades) {
    const c = await loadCandles(t.day);
    if (!c || !c[t.sym]) continue;
    const a = replay(t, c[t.sym], 0.5), b = replay(t, c[t.sym], 1);
    rows.push({ t, a, b, real: t.rMultiple });
  }
  if (!rows.length) return console.log('No trades with saved candles yet.');
  const sum = f => rows.reduce((x, r) => x + f(r), 0), n = rows.length, fx = x => x.toFixed(2);
  console.log(`Trades replayed: ${n}  (gross R, no charges; real net R avg ${fx(sum(r => r.real) / n)} for reference)`);
  console.log(`  BE at +0.5R (V3 replay)   total ${fx(sum(r => r.a.r))}R   avg ${fx(sum(r => r.a.r) / n)}R   win ${(rows.filter(r => r.a.r > 0).length / n * 100).toFixed(0)}%`);
  console.log(`  BE at +1R   (shadow)      total ${fx(sum(r => r.b.r))}R   avg ${fx(sum(r => r.b.r) / n)}R   win ${(rows.filter(r => r.b.r > 0).length / n * 100).toFixed(0)}%`);
  const be = rows.filter(r => r.t.mfeR >= 0.5 && r.a.why === 'stop' && Math.abs(r.a.r) < 0.1);
  console.log(`  V3 stopped at ~breakeven after +0.5R: ${be.length}; of those, price still reached 2R: ${be.filter(r => r.b.why === 'target').length}`);
  const drift = rows.filter(r => Math.abs(r.a.r - r.real) > 0.15).length;
  if (drift) console.log(`  Note: ${drift} replays differ from the real R by more than 0.15 (charges, fill timing). Treat small gaps as noise.`);
})().catch(e => { console.error(e.message); process.exit(1); });
