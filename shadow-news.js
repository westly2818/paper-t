// Shadow report: did the news check protect us? For every stock the news check removed (saved in each day's record as
// "shadow"), replay its day with the same entry and exit rules the live bot uses, WITHOUT ever having traded it, and compare
// the result with the trades the bot really took.
//   node --env-file=.env shadow-news.js              (Upstash Redis)
//   node shadow-news.js --dir data                   (local folder with days.jsonl, trades.jsonl and candles-*.json.gz)
//   node shadow-news.js --dir data --since 2026-10-05
// Needs sessions recorded after the shadow logging was added; older days have no "shadow" list.
// Results are net R per trade (charges and 0.02% slippage included, 5 stock cap and 1% risk sizing as in the bot).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const base = require('./config');
const { buildTradePlan, r05 } = require('./lib/planner');
const { aggregate, vwap, volumeRatio } = require('./lib/indicators');
const { minOfDay, OPEN } = require('./lib/time');
const { charges } = require('./lib/engine');

const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : null; };
const dir = arg('dir');
const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
const key = process.env.STATE_KEY || 'paper-trader:state';
const redis = async cmd => {
  const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: JSON.stringify(cmd) });
  const j = await r.json(); if (j.error) throw new Error(j.error); return j.result;
};
async function loadList(name) {
  if (dir) { const f = path.join(dir, name + '.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []; }
  if (!url) throw new Error('Set UPSTASH_REDIS_REST_URL/TOKEN (use --env-file=.env) or pass --dir <folder>');
  return (await redis(['LRANGE', key + ':' + name, 0, -1])).map(JSON.parse);
}
const cache = {};
async function loadCandles(day) {
  if (cache[day] !== undefined) return cache[day];
  let gz = null;
  if (dir) { const f = path.join(dir, `candles-${day}.json.gz`); gz = fs.existsSync(f) ? fs.readFileSync(f) : null; }
  else { const b = await redis(['GET', `${key}:candles:${day}`]); gz = b && Buffer.from(b, 'base64'); }
  return (cache[day] = gz ? JSON.parse(zlib.gunzipSync(gz)) : null);
}
const toObj = a => a.map(k => ({ t: k[0], o: k[1], h: k[2], l: k[3], c: k[4], v: k[5] }));

// Entry exactly as the bot decides it (closed 5-minute candle beyond the range, right side of VWAP and of Nifty, volume ratio, no chasing, inside the entry window).
function shadowTrade(info, c1, idx, cfg) {
  const plan = buildTradePlan(info, c1, cfg, cfg.capital);
  if (!plan) return { status: 'no data' };
  if (plan.status !== 'waiting') return { status: 'no setup: ' + plan.note };
  const bars = aggregate(c1, 5);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], endT = b.t + 300000;
    if (minOfDay(b.t) < OPEN + cfg.orMinutes) continue;
    if (minOfDay(b.t) + 5 > cfg.lastEntryMin) break;
    const done = bars.slice(0, i + 1), vw = vwap(c1.filter(k => k.t < endT)), vr = volumeRatio(done);
    const ix = idx.filter(k => k.t < endT), nifty = ix.length ? (ix[ix.length - 1].c > vwap(ix) ? 'up' : 'down') : 'unknown';
    for (const leg of Object.values(plan.legs)) {
      if (leg.status !== 'waiting') continue;
      const dir_ = leg.side === 'long' ? 1 : -1;
      if (dir_ === 1 ? b.l <= leg.sl && b.c < leg.trigger : b.h >= leg.sl && b.c > leg.trigger) { leg.status = 'expired'; continue; }
      if (dir_ === 1 ? b.h >= leg.tp : b.l <= leg.tp) { leg.status = 'expired'; continue; }
      if (!(dir_ === 1 ? b.c > leg.trigger : b.c < leg.trigger)) continue;
      if (!(dir_ === 1 ? b.c > vw : b.c < vw)) continue;
      if (vr < cfg.minVolRatio) continue;
      if (nifty !== 'unknown' && nifty !== (dir_ === 1 ? 'up' : 'down')) continue;
      if ((Math.abs(b.c - leg.trigger) / leg.trigger) * 100 > cfg.maxChasePct) continue;
      return exitReplay({ side: leg.side, price: b.c, stop: leg.sl, decidedAt: endT }, c1, cfg);
    }
  }
  return { status: 'no valid entry' };
}

// Same exit rules as the bot: stop first, 2R target, breakeven at breakevenR, trail 1R behind from +1.5R, close at 15:15.
function exitReplay(sg, c1, cfg) {
  const d = sg.side === 'long' ? 1 : -1, slip = cfg.slippagePct / 100;
  const fill = r05(sg.price * (1 + d * slip)), R = Math.abs(fill - sg.stop);
  if (R < fill * 0.002) return { status: 'stop too tight' };
  const qty = Math.floor(Math.min((cfg.capital * cfg.riskPct) / 100 / R, (cfg.capital * cfg.maxAllocPct) / 100 / fill));
  if (qty < 1) return { status: 'size below 1' };
  const tp = fill + d * cfg.rr * R, sq = cfg.squareOffMin;
  let sl = sg.stop, best = fill, exit = null;
  for (const k of c1) {
    if (k.t < sg.decidedAt) continue;
    if (minOfDay(k.t) >= sq) { exit = k.o * (1 - d * slip); break; }
    if (d === 1 ? k.o <= sl : k.o >= sl) { exit = k.o * (1 - d * slip); break; }
    if (d === 1 ? k.l <= sl : k.h >= sl) { exit = sl * (1 - d * slip); break; }
    if (d === 1 ? k.h >= tp : k.l <= tp) { exit = tp; break; }
    best = d === 1 ? Math.max(best, k.h) : Math.min(best, k.l);
    const g = ((best - fill) * d) / R;
    let ns = sl;
    if (g >= cfg.breakevenR) ns = d === 1 ? Math.max(ns, fill) : Math.min(ns, fill);
    if (g >= 1.5) ns = d === 1 ? Math.max(ns, best - R) : Math.min(ns, best + R);
    ns = r05(ns);
    if (d === 1 ? ns > sl : ns < sl) sl = ns;
  }
  if (exit == null) exit = c1[c1.length - 1].c;
  const gross = (exit - fill) * d * qty, fee = charges(d === 1 ? 'BUY' : 'SELL', qty * fill) + charges(d === 1 ? 'SELL' : 'BUY', qty * exit);
  return { status: 'entered', side: sg.side, fill, exit, r: (gross - fee) / (R * qty) };
}

function summary(label, rs) {
  if (!rs.length) return console.log(`  ${label.padEnd(34)} none`);
  const n = rs.length, m = rs.reduce((a, b) => a + b, 0) / n, sd = n > 1 ? Math.sqrt(rs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)) : NaN;
  console.log(`  ${label.padEnd(34)} trades ${String(n).padStart(3)}  win ${(rs.filter(r => r > 0).length / n * 100).toFixed(0)}%  avg ${m.toFixed(2)}R${n > 1 ? ` (+/-${(1.96 * sd / Math.sqrt(n)).toFixed(2)})` : ''}  total ${(m * n).toFixed(1)}R`);
}

(async () => {
  let days = (await loadList('days')).filter(d => d.shadow && d.shadow.length);
  const since = arg('since');
  if (since) days = days.filter(d => d.day >= since);
  const seen = new Set(); days = days.filter(d => !seen.has(d.day) && seen.add(d.day));
  const trades = await loadList('trades');
  if (!days.length) return console.log('No recorded session has a shadow list yet. It fills in from the first session after the shadow logging was deployed and the news check removed a stock.');
  const cfg = { ...base, riskPct: base.riskPct };
  const blocked = [], rows = [];
  for (const dRec of days) {
    const c = await loadCandles(dRec.day);
    if (!c) continue;
    const idx = toObj(c[base.indexSymbol] || []);
    for (const sh of dRec.shadow) {
      if (!c[sh.sym]) { rows.push({ day: dRec.day, sym: sh.sym, status: 'no saved prices', by: sh.blockedBy }); continue; }
      const res = shadowTrade(sh.info, toObj(c[sh.sym]), idx, cfg);
      rows.push({ day: dRec.day, sym: sh.sym, by: sh.blockedBy, reason: sh.reason, ...res });
      if (res.status === 'entered') blocked.push(res.r);
    }
  }
  const taken = trades.filter(t => days.some(d => d.day === t.day)).map(t => t.rMultiple).filter(x => x != null);
  console.log(`${days.length} sessions with a shadow list; ${rows.length} stocks removed by the news check.\n`);
  const byStatus = {}; for (const r of rows) byStatus[r.status.split(':')[0]] = (byStatus[r.status.split(':')[0]] || 0) + 1;
  console.log('What happened to the removed stocks: ' + Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(', ') + '\n');
  summary('Removed by news (would-have trades)', blocked);
  summary('Removed as "unverified" only', rows.filter(r => r.status === 'entered' && r.by === 'unverified').map(r => r.r));
  summary('Trades the bot really took', taken);
  console.log('\nHow to read it: if the removed group does clearly worse than the taken group, the news check is protecting you.');
  console.log('If it does the same or better, the check is costing you trades. Groups under about 30 trades each are noise.');
  console.log('\nDetail:'); for (const r of rows.filter(x => x.status === 'entered')) console.log(`  ${r.day} ${r.sym.padEnd(12)} ${r.side.padEnd(5)} ${r.r.toFixed(2)}R   (${r.by}: ${String(r.reason || '').slice(0, 80)})`);
})().catch(e => { console.error(e.message); process.exit(1); });
