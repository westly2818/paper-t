// Backtest that runs the REAL live Engine, unchanged, on historical prices. Only the data feed and the clock are replaced:
// the same morning ranking, trade plans, entry checks, backups, sizing, stops, breakeven, trailing, charges and day limits
// as the live bot (lib/engine.js). The one thing history cannot supply is the news check, so it is off (as in any replay).
//   node --max-old-space-size=10240 engine-backtest.js --fyers data/fyers-1m --daily data/fyers-daily
//   ... --from 2024-12-23 --to 2026-03-31          (a period)
//   ... --news            (also run the real news check: Google News headlines for that date + Gemini with the live prompt; needs GEMINI_API_KEY for uncached answers)
//   ... --prefetch-news    (only download and cache the headlines for every shortlisted stock, no Gemini)
//   ... --set breakevenR=1 --set lastEntryMin=840   (try a rule change; numbers/true/false; the baseline uses NO --set)
// Each session starts fresh with the starting capital (so days are independent), exactly like backtest.js.
const fs = require('fs');
const path = require('path');
const base = require('./config');
const { Engine } = require('./lib/engine');
const { Clock, NAMES, yf } = require('./lib/data');
const { checkNews } = require('./lib/gemini');
const newsHistory = require('./news-history');
const { atMinute, dayKey, CLOSE } = require('./lib/time');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const all = k => process.argv.flatMap((v, i) => (v === '--' + k ? [process.argv[i + 1]] : []));
const dir1 = arg('fyers', 'data/fyers-1m'), dirD = arg('daily', 'data/fyers-daily'), from = arg('from', null), to = arg('to', null);
const label = arg('label', 'baseline'), DEV_END = '2026-03-31';

// ---------------- historical data feed (implements the provider interface the Engine uses) ----------------
const FILE = { '^NSEI': 'NIFTY', '^INDIAVIX': 'INDIAVIX' };
const fileOf = s => (FILE[s] || s).replace(/[^A-Za-z0-9_&-]/g, '_');
class HistoricalProvider {
  constructor() {
    this.offline = true; this.min = {}; this.dly = {}; this.cache = new Map(); this.cacheDay = null; this.now = () => 0;
    let n = 0;
    for (const f of fs.readdirSync(dir1)) {
      if (!f.endsWith('.csv')) continue;
      const rows = fs.readFileSync(path.join(dir1, f), 'utf8').trim().split('\n').slice(1);
      const N = rows.length, T = new Float64Array(N), O = new Float64Array(N), H = new Float64Array(N), L = new Float64Array(N), C = new Float64Array(N), V = new Float64Array(N);
      const days = new Map();
      for (let j = 0; j < N; j++) {
        const r = rows[j].split(','); T[j] = Date.parse(r[0]); O[j] = +r[1]; H[j] = +r[2]; L[j] = +r[3]; C[j] = +r[4]; V[j] = +r[5];
        const k = dayKey(T[j]), d = days.get(k); if (!d) days.set(k, [j, j]); else d[1] = j;
      }
      this.min[f.slice(0, -4)] = { T, O, H, L, C, V, days }; n++;
    }
    for (const f of fs.readdirSync(dirD)) {
      if (!f.endsWith('.csv')) continue;
      this.dly[f.slice(0, -4)] = fs.readFileSync(path.join(dirD, f), 'utf8').trim().split('\n').slice(1).map(l => l.split(',')).map(r => ({ t: Date.parse(r[0]), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
    }
    console.log(`Loaded ${n} instruments of 1-minute data and ${Object.keys(this.dly).length} of daily data`);
  }
  async daily(sym, beforeDay) {
    const d = this.dly[fileOf(sym)];
    if (!d) throw new Error(`${sym}: no daily file`);
    return d.filter(c => dayKey(c.t) < beforeDay);
  }
  async intraday(sym, day) {
    const m = this.min[fileOf(sym)];
    if (!m) throw new Error(`${sym}: no 1-minute file`);
    if (this.cacheDay !== day) { this.cache.clear(); this.cacheDay = day; }
    let arr = this.cache.get(sym);
    if (!arr) {
      const r = m.days.get(day); arr = [];
      if (r) for (let j = r[0]; j <= r[1]; j++) arr.push({ t: m.T[j], o: m.O[j], h: m.H[j], l: m.L[j], c: m.C[j], v: m.V[j] });
      this.cache.set(sym, arr);
    }
    const now = this.now();
    return arr.filter(c => c.t + 60000 <= now); // only candles that had closed by the simulated clock
  }
  tradingDays() { return [...this.min.NIFTY.days.keys()].sort(); }
}

// ---------------- config: the live config, plus only the overrides you pass with --set ----------------
let quotaStop = null;
const NEWS = process.argv.includes('--news'), PREFETCH = process.argv.includes('--prefetch-news');
const cfg = { ...base, mode: 'replay', newsGuard: NEWS, newsAuto: NEWS, upstashUrl: null, stateFile: null };
if (NEWS && !process.env.GEMINI_API_KEY && !process.env.LLM_API_KEY_FREE) process.env.GEMINI_API_KEY = 'cached-only'; // cached answers still work; a cache miss then fails closed
const POOLS = path.join(__dirname, 'data', 'engine-bt-pools.json');

// company names exactly as the live bot gets them (Yahoo's long name), cached once
async function loadNames(symbols) {
  const f = path.join(__dirname, 'data', 'names.json');
  let m = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  const todo = symbols.filter(x => !m[x]);
  let i = 0;
  const worker = async () => { while (i < todo.length) { const sym = todo[i++]; try { await yf(sym, '1d', '5d', 2); if (NAMES.get(sym)) m[sym] = NAMES.get(sym); } catch (e) { /* name stays unknown, like live */ } } };
  await Promise.all([worker(), worker(), worker(), worker()]);
  fs.writeFileSync(f, JSON.stringify(m));
  for (const [k, v] of Object.entries(m)) NAMES.set(k, v);
  return m;
}
const overrides = {};
for (const kv of all('set')) {
  const [k, v] = kv.split('=');
  if (!(k in cfg)) throw new Error(`Unknown setting "${k}"`);
  cfg[k] = v === 'true' ? true : v === 'false' ? false : isNaN(+v) ? v : +v; overrides[k] = cfg[k];
}

(async () => {
  const provider = new HistoricalProvider();
  if (NEWS || PREFETCH) { const nm = await loadNames(base.watchlist); console.log(`Company names known for ${Object.keys(nm).length} of ${base.watchlist.length} stocks`); }
  const clock = new Clock('replay', 60);
  provider.now = () => clock.now();
  let days = provider.tradingDays().filter(d => (!from || d >= from) && (!to || d <= to));
  if (PREFETCH) {
    if (!fs.existsSync(POOLS)) throw new Error('Run the plain backtest once first (it writes ' + POOLS + ')');
    const pools = JSON.parse(fs.readFileSync(POOLS, 'utf8')), { stockHeadlines, marketHeadlines } = require('./lib/newsfeed');
    let n = 0;
    for (const d of days) {
      const syms = pools[d]; if (!syms) continue;
      newsHistory.setDay(d);
      const nowMs = Date.parse(d + 'T03:35:00Z');
      for (const sym of syms) { try { await stockHeadlines({ symbol: sym, name: NAMES.get(sym), windowHours: cfg.newsWindowHours, nowMs, fetchImpl: newsHistory.historicalFetch }); } catch (e) { /* fails closed in the real run */ } n++; }
      try { await marketHeadlines({ windowHours: cfg.newsWindowHours, nowMs, fetchImpl: newsHistory.historicalFetch }); } catch (e) { /* ignore */ }
      if (days.indexOf(d) % 10 === 0) console.log(`  ${d}: ${n} stock-days done; fetched ${newsHistory.stats.rssFetched}, from cache ${newsHistory.stats.rssCached}`);
    }
    console.log('Prefetch finished', newsHistory.stats); return;
  }
  console.log(`Running the live Engine on ${days.length} sessions (${days[0]} to ${days[days.length - 1]}), capital ${cfg.capital} each day, overrides: ${JSON.stringify(overrides)}\n`);
  const trades = [], signals = [], perDay = [];
  let t0 = Date.now();
  for (let di = 0; di < days.length; di++) {
    const day = days[di];
    const eng = new Engine(cfg, provider, clock);
    newsHistory.setDay(day);
    if (NEWS) eng.checkNews = async args => {
      try { return await checkNews({ ...args, fetchImpl: newsHistory.historicalFetch, wait: () => Promise.resolve() }); }
      catch (e) { if (/Gemini HTTP|quota|busy|No Gemini answer cached|empty answer|network error/i.test(e.message)) quotaStop = quotaStop || e.message; throw e; }
    };
    eng.queue = (name, rec) => {
      if (name === 'signals') { signals.push(rec); return; }
      if (name !== 'trades') return;
      // keep the news behind every trade: the check's verdict and reason for this stock, its headlines, and the market-risk call
      const W = eng.S.watch || {}, N = W.news || {};
      const rep = (W.replacementNews || []).map(r => r.stocks && r.stocks[rec.sym]).find(Boolean);
      const d = (N.details && N.details[rec.sym]) || rep || null;
      rec.newsInfo = { verdict: d ? (d.block === false ? true : d.block === true ? false : null) : (rec.ctx ? rec.ctx.newsVerdict : null), viaReplacement: !!(!(N.details && N.details[rec.sym]) && rep), status: N.status || 'off', marketRisk: N.market || null, marketSummary: N.marketSummary || '', model: N.model || ((W.replacementNews || []).find(r => r.stocks && r.stocks[rec.sym]) || {}).model || null, reason: d ? d.reason : '', risk: d ? d.risk : null, headlinesSeen: d ? d.headlinesSeen : null, sources: d ? (d.sources || []).map(x => ({ title: x.title, source: x.source, published: x.published })) : [] };
      trades.push(rec);
    };
    let t = atMinute(day, 9 * 60 + 5); const end = atMinute(day, CLOSE + 2);
    clock.now = () => t;
    let err = null;
    quotaStop = null;
    while (t <= end) { await eng.poll(); if (eng.S.error) { err = eng.S.error; if (!/Retrying|rate/i.test(err)) break; } t += 60000; }
    if (quotaStop) {
      console.log(`
STOPPED at ${day}: the Gemini check could not run (${quotaStop}).
Every answer so far is cached in data/news-cache/gemini, so run the same command again later (free-tier quota resets daily) and it resumes. No result is reported from a partial news run.`);
      process.exit(2);
    }
    perDay.push({ day, trades: eng.S.closed.length, picked: eng.S.watch ? eng.S.watch.picked.map(p => p.sym) : [], pool: eng.S.watch ? (eng.S.watch.pool || []).map(p => p.sym) : [], avoided: eng.S.watch && eng.S.watch.news ? eng.S.watch.news.avoided || [] : [], unverified: eng.S.watch && eng.S.watch.news ? eng.S.watch.news.unverified || [] : [], initial: eng.S.watch && eng.S.watch.news && eng.S.watch.news.verdicts ? Object.keys(eng.S.watch.news.verdicts).length : 0, marketRisk: eng.S.watch && eng.S.watch.news ? eng.S.watch.news.market : null, err });
    if ((di + 1) % 25 === 0) console.log(`  ${di + 1}/${days.length} sessions, ${trades.length} trades so far (${Math.round((Date.now() - t0) / 1000)}s)`);
  }
  fs.writeFileSync(path.join(__dirname, 'data', `engine-bt-${label}-days.json`), JSON.stringify(perDay.map(d => ({ day: d.day, trades: d.trades, marketRisk: d.marketRisk, avoided: d.avoided.length, unverified: d.unverified.length }))));
  if (!NEWS && !Object.keys(overrides).length) fs.writeFileSync(POOLS, JSON.stringify(Object.fromEntries(perDay.map(d => [d.day, d.pool]))));
  const errDays = perDay.filter(d => d.err);
  if (errDays.length) console.log(`\n${errDays.length} sessions ended with an engine message, first: ${errDays[0].day} ${errDays[0].err}`);

  // ---------------- report ----------------
  const f = (v, d = 2) => (v == null || !isFinite(v) ? '-' : v.toFixed(d));
  const stat = tr => {
    const n = tr.length; if (!n) return null;
    const m = tr.reduce((a, x) => a + x.rMultiple, 0) / n, sd = Math.sqrt(tr.reduce((a, x) => a + (x.rMultiple - m) ** 2, 0) / Math.max(1, n - 1));
    const gw = tr.filter(x => x.net > 0).reduce((a, x) => a + x.net, 0), gl = -tr.filter(x => x.net <= 0).reduce((a, x) => a + x.net, 0);
    let cum = 0, peak = 0, dd = 0, st = 0, ms = 0; for (const x of tr) { cum += x.net; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); st = x.net > 0 ? 0 : st + 1; ms = Math.max(ms, st); }
    return { n, m, ci: 1.96 * sd / Math.sqrt(n), win: tr.filter(x => x.net > 0).length / n * 100, pf: gl > 0 ? gw / gl : Infinity, net: cum, dd, ms, t2: tr.filter(x => /Target/.test(x.exitReason)).length / n * 100, gross: tr.reduce((a, x) => a + x.gross, 0), fees: tr.reduce((a, x) => a + x.fees, 0) };
  };
  const line = (label2, tr) => { const s = stat(tr); console.log(s ? `  ${label2.padEnd(13)} trades ${String(s.n).padStart(4)}  win ${f(s.win, 0)}%  avg ${f(s.m)}R (+/-${f(s.ci)})  PF ${f(s.pf)}  net Rs ${f(s.net, 0).padStart(6)}  (gross ${f(s.gross, 0)}, charges ${f(s.fees, 0)})  maxDD Rs ${f(s.dd, 0)}  loss streak ${s.ms}  2R hit ${f(s.t2, 0)}%` : `  ${label2.padEnd(13)} no trades`); };
  console.log(`\nRESULT: live Engine, ${label}${Object.keys(overrides).length ? ' ' + JSON.stringify(overrides) : ' (live config, no overrides)'}`);
  line('all', trades);
  line('development', trades.filter(x => x.day <= DEV_END)); line('holdout', trades.filter(x => x.day > DEV_END));
  line('long', trades.filter(x => x.side === 'long')); line('short', trades.filter(x => x.side === 'short'));
  line('from backup', trades.filter(x => x.ctx && x.ctx.fromBackup));
  const months = {}; for (const x of trades) months[x.day.slice(0, 7)] = (months[x.day.slice(0, 7)] || 0) + x.net;
  console.log(`  months positive ${Object.values(months).filter(v => v > 0).length} of ${Object.keys(months).length}; sessions with a trade ${new Set(trades.map(x => x.day)).size} of ${days.length}`);
  const fresh = trades.filter(x => x.ctx && x.ctx.crossedBefore != null);
  line('fresh break', fresh.filter(x => x.ctx.crossedBefore === 0)); line('late break', fresh.filter(x => x.ctx.crossedBefore > 0));
  if (NEWS) {
    const avoidedDays = perDay.filter(d => d.avoided.length);
    console.log(`  news check: ${avoidedDays.length} sessions removed at least one stock (${perDay.reduce((a, d) => a + d.avoided.length, 0)} stocks); cache: ${JSON.stringify(newsHistory.stats)}`);
    const cleared = trades.filter(x => x.newsInfo && x.newsInfo.verdict === true), unver = trades.filter(x => x.newsInfo && x.newsInfo.verdict == null);
    line('news cleared', cleared); line('news unverified', unver);
    const init = perDay.reduce((a, d) => a + d.initial, 0), unv = perDay.reduce((a, d) => a + d.unverified.length, 0), av = perDay.reduce((a, d) => a + d.avoided.length, 0);
    console.log(`  initial shortlist checks ${init}: cleared ${init - av} (${f((init - av) / init * 100, 0)}%), blocked by Gemini ${av - unv} (${f((av - unv) / init * 100, 0)}%), unverified (no usable headline or answer) ${unv} (${f(unv / init * 100, 0)}%)`);
    const mk = {}; for (const d of perDay) mk[d.marketRisk || 'none'] = (mk[d.marketRisk || 'none'] || 0) + 1;
    console.log('  market-risk call per session: ' + JSON.stringify(mk));
  }
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(`data/engine-bt-${label}-trades.json`, JSON.stringify(trades.map(x => ({ day: x.day, sym: x.sym, side: x.side, qty: x.qty, entry: x.entry, exit: x.exit, net: x.net, rMultiple: x.rMultiple, exitReason: x.exitReason, entryReason: x.entryReason, crossedBefore: x.ctx && x.ctx.crossedBefore, news: x.newsInfo })), null, 1));
  fs.writeFileSync(`data/engine-bt-${label}.csv`, 'day,sym,side,qty,entry,exit,net,rMultiple,exitReason,fromBackup,crossedBefore,volRatio\n' + trades.map(x => [x.day, x.sym, x.side, x.qty, x.entry, x.exit, f(x.net, 1), f(x.rMultiple, 3), x.exitReason, x.ctx && x.ctx.fromBackup ? 1 : 0, x.ctx ? x.ctx.crossedBefore : '', x.ctx ? f(x.ctx.volRatio) : ''].join(',')).join('\n'));
  console.log(`\nSaved data/engine-bt-${label}.csv. ${signals.length} breakout signals were logged.`);
})().catch(e => { console.error('Failed:', e.stack || e.message); process.exit(1); });
