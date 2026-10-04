// Compare strategy variants on the SAME live signals, so one running bot answers "which rule set is better".
// Every breakout candle the bot saw (taken or rejected) is in the signal log with all its conditions, and the
// day's 1-minute candles are saved. Each variant picks its own entries from those signals and replays them
// with its own exit rule, using 1-minute candles (exact order of stop and target inside most bars).
//   node --env-file=.env strategies.js            (Upstash Redis)
//   node strategies.js --dir data                 (local folder with signals.jsonl and candles-*.json.gz)
//   node strategies.js --dir data --since 2026-10-05
// Results are gross R per trade (no charges, about 0.1 to 0.15R per trade at this capital), one entry per
// stock per day, no position or capital limits. They rank rule sets; they are not a profit forecast.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { minOfDay } = require('./lib/time');
const { r05 } = require('./lib/planner');

const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : null; };
const dir = arg('dir');
const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
const key = process.env.STATE_KEY || 'paper-trader:state';
const redis = async cmd => {
  const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: JSON.stringify(cmd) });
  const j = await r.json(); if (j.error) throw new Error(j.error); return j.result;
};
const SQ = 15 * 60 + 15, SLIP = 0.0002, RR = 2;

async function loadSignals() {
  if (dir) { const f = path.join(dir, 'signals.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []; }
  if (!url) throw new Error('Set UPSTASH_REDIS_REST_URL/TOKEN (use --env-file=.env) or pass --dir <folder>');
  return (await redis(['LRANGE', key + ':signals', 0, -1])).map(JSON.parse);
}
const cache = {};
async function loadCandles(day) {
  if (cache[day] !== undefined) return cache[day];
  let gz = null;
  if (dir) { const f = path.join(dir, `candles-${day}.json.gz`); gz = fs.existsSync(f) ? fs.readFileSync(f) : null; }
  else { const b = await redis(['GET', `${key}:candles:${day}`]); gz = b && Buffer.from(b, 'base64'); }
  return (cache[day] = gz ? JSON.parse(zlib.gunzipSync(gz)) : null);
}

// ---- the strategies being compared. Add a line to test another rule set. ----
// pass(sig): extra entry condition on top of "every V3 condition passed". beR: breakeven trigger (99 = none).
const known = v => v != null;
const VARIANTS = [
  { name: 'V3 (live rules)', beR: 0.5, pass: () => true },
  { name: 'V3 with breakeven at +1R', beR: 1, pass: () => true },
  { name: 'V3 with no breakeven or trail', beR: 99, pass: () => true },
  { name: 'V3 + same-slot RVOL >= 1.0', beR: 0.5, pass: s => known(s.rvolSlot) && s.rvolSlot >= 1.0 },
  { name: 'V3 + same-slot RVOL >= 1.2', beR: 0.5, pass: s => known(s.rvolSlot) && s.rvolSlot >= 1.2 },
  { name: 'V3 + cumulative RVOL >= 0.7', beR: 0.5, pass: s => known(s.rvolCum) && s.rvolCum >= 0.7 },
  { name: 'V3 + cumulative RVOL >= 1.0', beR: 0.5, pass: s => known(s.rvolCum) && s.rvolCum >= 1.0 },
  { name: 'V3 + gap under 1%', beR: 0.5, pass: s => known(s.gapPct) && Math.abs(s.gapPct) < 1 },
  { name: 'V3 fresh breakouts only (no 2nd/3rd attempt)', beR: 0.5, pass: s => known(s.crossedBefore) && s.crossedBefore === 0 },
  { name: 'V3 late breakouts only (study)', beR: 0.5, pass: s => known(s.crossedBefore) && s.crossedBefore > 0 },
  { name: 'V4 candidate (RVOL slot>=1.0, cum>=0.7, BE +1R)', beR: 1, pass: s => known(s.rvolSlot) && s.rvolSlot >= 1.0 && known(s.rvolCum) && s.rvolCum >= 0.7 }
];

// Same exit logic as the engine: stop first, then target; stop to breakeven at beR; trail 1R behind from +1.5R.
function replay(sig, m1, beR) {
  const d = sig.side === 'long' ? 1 : -1;
  const fill = sig.price * (1 + d * SLIP), R = Math.abs(fill - sig.stop);
  if (R < fill * 0.002 || (d === 1 ? sig.price <= sig.stop : sig.price >= sig.stop)) return null;
  const tp = fill + d * RR * R;
  let sl = sig.stop, best = fill;
  for (const k of m1) {
    if (k[0] < sig.decidedAt) continue;
    const [, o, h, l] = k;
    if (minOfDay(k[0]) >= SQ) return ((o * (1 - d * SLIP) - fill) * d) / R;
    if (d === 1 ? o <= sl : o >= sl) return ((o * (1 - d * SLIP) - fill) * d) / R;
    if (d === 1 ? l <= sl : h >= sl) return ((sl * (1 - d * SLIP) - fill) * d) / R;
    if (d === 1 ? h >= tp : l <= tp) return RR;
    best = d === 1 ? Math.max(best, h) : Math.min(best, l);
    const g = ((best - fill) * d) / R;
    let ns = sl;
    if (g >= beR) ns = d === 1 ? Math.max(ns, fill) : Math.min(ns, fill);
    if (beR < 90 && g >= 1.5) ns = d === 1 ? Math.max(ns, best - R) : Math.min(ns, best + R);
    ns = r05(ns);
    if (d === 1 ? ns > sl : ns < sl) sl = ns;
  }
  const k = m1[m1.length - 1];
  return ((k[4] - fill) * d) / R;
}

const f = (v, d = 2) => (v == null || !isFinite(v) ? '-' : v.toFixed(d));
function summarize(rs) {
  const n = rs.length;
  if (!n) return null;
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : NaN;
  const gw = rs.filter(r => r > 0).reduce((a, b) => a + b, 0), gl = -rs.filter(r => r <= 0).reduce((a, b) => a + b, 0);
  return { n, mean, ci: 1.96 * sd / Math.sqrt(n), total: mean * n, win: rs.filter(r => r > 0).length / n * 100, pf: gl > 0 ? gw / gl : Infinity, hit2: rs.filter(r => r >= 1.99).length / n * 100 };
}

(async () => {
  let sigs = await loadSignals();
  const since = arg('since');
  if (since) sigs = sigs.filter(s => s.day >= since);
  const seen = new Set();
  sigs = sigs.filter(s => { const k = s.day + s.decidedAt + s.sym + s.side; if (seen.has(k)) return false; seen.add(k); return true; });
  sigs.sort((a, b) => a.decidedAt - b.decidedAt);
  const days = new Set(sigs.map(s => s.day));
  console.log(`${sigs.length} breakout candles logged over ${days.size} sessions${since ? ' since ' + since : ''}.`);
  const withFeat = sigs.filter(s => s.rvolSlot != null).length;
  console.log(`${withFeat} of them carry the volume baseline (older signals do not, so RVOL variants only see newer sessions).\n`);
  if (!sigs.length) return;

  const cands = {};
  const out = VARIANTS.map(() => []);
  const perDay = VARIANTS.map(() => new Map());
  for (const s of sigs) {
    if (!Object.values(s.conditions || {}).every(ok => ok !== false)) continue; // must pass every V3 condition
    const c = cands[s.day] !== undefined ? cands[s.day] : (cands[s.day] = await loadCandles(s.day));
    const m1 = c && c[s.sym];
    if (!m1) continue;
    VARIANTS.forEach((V, i) => {
      const k = s.day + '|' + s.sym;
      if (perDay[i].has(k) || !V.pass(s)) return;
      const r = replay(s, m1, V.beR);
      if (r == null) return;
      perDay[i].set(k, r); out[i].push(r);
    });
  }

  console.log('Variant'.padEnd(52) + ' trades   win%   avgR  (95% range)    totalR    PF   hit 2R%');
  VARIANTS.forEach((V, i) => {
    const s = summarize(out[i]);
    if (!s) return console.log(V.name.padEnd(52) + ' no qualifying trades yet');
    console.log(V.name.padEnd(52) + String(s.n).padStart(6) + f(s.win, 0).padStart(7) + f(s.mean).padStart(7) + (s.n > 1 ? ' +/-' + f(s.ci) : '').padStart(8) + f(s.total, 1).padStart(10) + f(s.pf).padStart(7) + f(s.hit2, 0).padStart(9));
  });

  const n0 = out[0].length;
  console.log('\nHow to read this:');
  console.log('  "95% range" is how far the true average could be from the shown one. If two variants\' ranges overlap, you cannot say one is better.');
  if (n0 < 30) console.log(`  V3 has only ${n0} trades. Under 30 the ranges are huge: keep collecting, change nothing.`);
  else if (n0 < 100) console.log(`  V3 has ${n0} trades: a first hint at most. 100+ trades are needed before choosing between close variants.`);
  else console.log(`  V3 has ${n0} trades: enough to compare variants whose ranges do not overlap.`);
  console.log('  A variant that only takes a few of the trades looks better or worse by luck. Compare "trades" before "avgR".');
})().catch(e => { console.error(e.message); process.exit(1); });
