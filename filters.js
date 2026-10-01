// Does each entry filter earn its keep? Uses the permanent signal log (every candle that broke an
// opening-range level, with ALL conditions), replays what would have happened if each rejected
// setup had been taken anyway, and compares it with the setups that passed everything.
//   node --env-file=.env filters.js               (Upstash Redis)
//   node filters.js --dir data                     (local folder with signals.jsonl and candles-*.json.gz)
//   node filters.js --dir <folder> --version 3     (one strategy version only)
//   node filters.js --dir <folder> --until 10:00   (only candles decided by that time)
// What-if exit: entry at the signal candle's close, the plan's stop, target = 2x stop distance,
// everything closed at 15:15, 0.02% slippage. No breakeven or trailing, so every group is judged
// the same way. Costs are not included (about 0.1R per trade in this system).
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
const SQ = 15 * 60 + 15, SLIP = 0.0002, RR = 2;

async function loadSignals() {
  if (dir) { const f = path.join(dir, 'signals.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []; }
  if (!url) throw new Error('Set UPSTASH_REDIS_REST_URL/TOKEN (use --env-file=.env) or pass --dir <folder>');
  return (await redis(['LRANGE', key + ':signals', 0, -1])).map(JSON.parse);
}
const candleCache = {};
async function loadCandles(day) {
  if (candleCache[day] !== undefined) return candleCache[day];
  let gz = null;
  if (dir) { const f = path.join(dir, `candles-${day}.json.gz`); gz = fs.existsSync(f) ? fs.readFileSync(f) : null; }
  else { const b = await redis(['GET', `${key}:candles:${day}`]); gz = b && Buffer.from(b, 'base64'); }
  return (candleCache[day] = gz ? JSON.parse(zlib.gunzipSync(gz)) : null);
}

function whatIf(sig, m1) {
  const dir_ = sig.side === 'long' ? 1 : -1;
  const fill = sig.price * (1 + dir_ * SLIP), dist = Math.abs(fill - sig.stop);
  if (dist < fill * 0.002 || (dir_ === 1 ? sig.price <= sig.stop : sig.price >= sig.stop)) return null;
  const tp = fill + dir_ * RR * dist;
  for (const k of m1) {
    if (k[0] < sig.decidedAt) continue;
    if (mod(k[0]) >= SQ) return ((k[1] - fill) * dir_) / dist;
    if (dir_ === 1 ? k[3] <= sig.stop : k[2] >= sig.stop) return -1;
    if (dir_ === 1 ? k[2] >= tp : k[3] <= tp) return RR;
  }
  const k = m1[m1.length - 1];
  return ((k[4] - fill) * dir_) / dist;
}

const NAMES = { window: 'entry window', alive: 'setup still valid', vwap: 'VWAP', volume: 'volume', nifty: 'Nifty', chase: 'not chasing', room: 'room to trade' };
const line = (name, rs) => {
  if (!rs.length) return `  ${name.padEnd(30)} none`;
  const sum = rs.reduce((a, b) => a + b, 0);
  const p = f => (rs.filter(f).length / rs.length * 100).toFixed(0).padStart(3) + '%';
  return `  ${name.padEnd(30)} n=${String(rs.length).padStart(4)}  avg ${(sum / rs.length).toFixed(2).padStart(6)}R  total ${sum.toFixed(1).padStart(7)}R  win ${p(r => r > 0)}  hit 2R ${p(r => r >= 1.99)}  stopped ${p(r => r <= -0.99)}`;
};

(async () => {
  let sigs = await loadSignals();
  const v = arg('version');
  if (v) sigs = sigs.filter(s => String(s.strategyVersion) === v);
  const until = arg('until');
  if (until) { const [h, m] = until.split(':').map(Number); sigs = sigs.filter(s => mod(s.decidedAt) <= h * 60 + m); }
  const rows = [];
  for (const s of sigs) {
    const c = await loadCandles(s.day);
    const m1 = c && c[s.sym];
    if (!m1) continue;
    const r = whatIf(s, m1);
    if (r == null) continue;
    const bad = Object.entries(s.conditions).filter(([, ok]) => ok === false).map(([k]) => k);
    rows.push({ s, r, bad, leg: `${s.day}|${s.sym}|${s.side}` });
  }
  console.log(`${sigs.length} breakout candles logged, ${rows.length} with candles to replay (${new Set(rows.map(x => x.s.day)).size} sessions)\n`);
  if (!rows.length) return;

  const group = (label, filter, firstOnly) => {
    let list = rows.filter(filter);
    if (firstOnly) { const seen = new Set(); list = list.filter(x => { const k = x.leg + '|' + label; if (seen.has(k)) return false; seen.add(k); return true; }); }
    return list.map(x => x.r);
  };
  for (const [title, firstOnly] of [['EVERY breakout candle', false], ['FIRST breakout candle per stock and side per day (cleaner, less repeated)', true]]) {
    console.log(title);
    console.log(line('Passed every condition', group('pass', x => x.bad.length === 0, firstOnly)));
    for (const k of Object.keys(NAMES)) console.log(line(`Rejected ONLY by ${NAMES[k]}`, group('only' + k, x => x.bad.length === 1 && x.bad[0] === k, firstOnly)));
    console.log(line('Rejected by 2 or more', group('multi', x => x.bad.length >= 2, firstOnly)));
    console.log();
  }
  console.log('How to read it: if "Rejected ONLY by X" does as well as or better than "Passed every condition",');
  console.log('filter X is probably costing you trades that would have worked. If it does clearly worse, X earns its keep.');
  console.log('Small groups (n under 30) are noise.');
})().catch(e => { console.error(e.message); process.exit(1); });
