const { dayKey, minOfDay, atMinute, isWeekday, OPEN, CLOSE } = require('./time');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const NAMES = new Map(); // NSE symbol -> company name, filled from Yahoo responses
const ysym = s => (s.startsWith('^') ? s : `${s}.NS`);

// ---------------------------------------------------------------------------
// Yahoo Finance (unofficial public chart endpoint). Real NSE prices, may be delayed
// and can change or rate-limit without notice.
// ---------------------------------------------------------------------------
async function yf(symbol, interval, range, tries = 3) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ysym(symbol))}?interval=${interval}&range=${range}&includePrePost=false`;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (paper-trader)', Accept: 'application/json' } });
      if (res.status === 429) { await sleep(1500 * (i + 1)); lastErr = new Error('rate limited (HTTP 429)'); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const r = j && j.chart && j.chart.result && j.chart.result[0];
      if (!r || !r.timestamp) throw new Error('no data returned');
      if (r.meta && (r.meta.longName || r.meta.shortName)) NAMES.set(symbol, r.meta.longName || r.meta.shortName);
      const q = r.indicators.quote[0];
      const out = [];
      for (let k = 0; k < r.timestamp.length; k++) {
        if (q.close[k] == null || q.open[k] == null || q.high[k] == null || q.low[k] == null) continue;
        out.push({ t: r.timestamp[k] * 1000, o: q.open[k], h: q.high[k], l: q.low[k], c: q.close[k], v: q.volume[k] || 0 });
      }
      return out;
    } catch (e) { lastErr = e; await sleep(700); }
  }
  throw new Error(`${symbol}: ${lastErr && lastErr.message}`);
}

class YahooProvider {
  constructor(clock, cfg) {
    this.clock = clock; this.cfg = cfg;
    this.dailyCache = new Map(); this.intraCache = new Map();
  }
  async daily(sym, beforeDay) {
    if (!this.dailyCache.has(sym)) this.dailyCache.set(sym, await yf(sym, '1d', '1y'));
    return this.dailyCache.get(sym).filter(c => dayKey(c.t) < beforeDay);
  }
  async intraday(sym, day) {
    const replay = this.cfg.mode === 'replay';
    let entry = this.intraCache.get(sym);
    const stale = !entry || (!replay && Date.now() - entry.at > 10000);
    if (stale) {
      const candles = await yf(sym, '1m', replay ? '7d' : '1d');
      entry = { at: Date.now(), candles };
      this.intraCache.set(sym, entry);
    }
    const now = this.clock.now();
    return entry.candles.filter(c => dayKey(c.t) === day && (!replay || c.t + 60000 <= now));
  }
  // Latest session that has a complete 1-minute record (used for replay)
  async pickReplayDay() {
    if (this.cfg.replayDay) return this.cfg.replayDay;
    const idx = await yf(this.cfg.indexSymbol, '1m', '7d');
    const last = new Map();
    for (const c of idx) last.set(dayKey(c.t), Math.max(last.get(dayKey(c.t)) || 0, minOfDay(c.t)));
    const days = [...last.entries()].filter(([, m]) => m >= CLOSE - 8).map(([d]) => d).sort();
    if (!days.length) throw new Error('No complete recent session found in Yahoo data');
    return days[days.length - 1];
  }
}

// ---------------------------------------------------------------------------
// Demo provider: synthetic prices so the whole system can be tried offline.
// ---------------------------------------------------------------------------
function rng(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) { h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gaussFrom = r => () => { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
const BASE = { RELIANCE: 1400, TCS: 3200, INFY: 1550, HDFCBANK: 1000, ICICIBANK: 1350, SBIN: 820, AXISBANK: 1100, KOTAKBANK: 2100, ITC: 420, LT: 3600, BHARTIARTL: 1900, TATASTEEL: 160, ONGC: 245, NTPC: 340, WIPRO: 260, HCLTECH: 1500, POWERGRID: 300, COALINDIA: 400, ADANIPORTS: 1350, JSWSTEEL: 1050, HINDALCO: 700, SUNPHARMA: 1700, TECHM: 1450, BPCL: 320, IOC: 145, 'M&M': 3100, '^NSEI': 24500, '^INDIAVIX': 14 };

class DemoProvider {
  constructor(clock, cfg) { this.clock = clock; this.cfg = cfg; this.day = cfg.replayDay || dayKey(Date.now()); this.cache = new Map(); this.idxCache = new Map(); }
  async pickReplayDay() { return this.day; }
  _index(day) {
    if (this.idxCache.has(day)) return this.idxCache.get(day);
    const r = rng('IDX' + day), g = gaussFrom(r);
    const dayDrift = g() * 0.00018;
    const rets = []; for (let i = 0; i < 375; i++) rets.push(dayDrift + g() * 0.00045);
    this.idxCache.set(day, rets); return rets;
  }
  _gen(sym, day) {
    const key = sym + '|' + day;
    if (this.cache.has(key)) return this.cache.get(key);
    const r = rng(sym + day), g = gaussFrom(r);
    const base = BASE[sym] || 200 + Math.floor(r() * 800);
    const isIdx = sym.startsWith('^');
    const beta = isIdx ? 1 : 0.6 + r() * 0.9;
    // daily history
    const daily = [];
    let p = base * (0.85 + r() * 0.1), drift = g() * 0.002;
    const dayMs = atMinute(day, OPEN);
    let k = 0, ts = dayMs;
    const stamps = [];
    while (stamps.length < 130) { ts -= 86400000; if (isWeekday(ts)) stamps.push(ts); }
    stamps.reverse();
    for (const t of stamps) {
      drift = drift * 0.95 + g() * 0.0012;
      const o = p * (1 + g() * 0.004), c = o * Math.exp(drift + g() * 0.011);
      const h = Math.max(o, c) * (1 + Math.abs(g()) * 0.004), l = Math.min(o, c) * (1 - Math.abs(g()) * 0.004);
      daily.push({ t, o, h, l, c, v: Math.floor((2e6 + r() * 4e6) * (300 / Math.max(base, 50)) * 4) });
      p = c; k++;
    }
    // today's minute candles
    const idxRets = this._index(day);
    const minute = [];
    const trend = g() * 0.00028 + (drift > 0 ? 0.00006 : -0.00006);
    let px = p * (1 + g() * 0.006);
    for (let i = 0; i < 375; i++) {
      const ret = isIdx ? idxRets[i] : beta * idxRets[i] + trend + g() * 0.0009;
      const o = px, c = o * (1 + ret);
      const h = Math.max(o, c) * (1 + Math.abs(g()) * 0.0004), l = Math.min(o, c) * (1 - Math.abs(g()) * 0.0004);
      const u = 1 + 1.5 * Math.exp(-i / 25) + 1.0 * Math.exp(-(374 - i) / 20);
      minute.push({ t: dayMs + i * 60000, o, h, l, c, v: isIdx ? 0 : Math.floor(u * (8000 + r() * 8000) * (300 / Math.max(base, 50))) });
      px = c;
    }
    const out = { daily, minute };
    this.cache.set(key, out);
    return out;
  }
  async daily(sym, beforeDay) { return this._gen(sym, beforeDay).daily.filter(c => dayKey(c.t) < beforeDay); }
  async intraday(sym, day) { const now = this.clock.now(); return this._gen(sym, day).minute.filter(c => dayKey(c.t) === day && c.t + 60000 <= now); }
}

class Clock {
  constructor(mode, speed) { this.mode = mode; this.speed = speed; this.paused = false; this.anchorReal = Date.now(); this.anchorVirtual = 0; this.frozen = 0; this.endMs = Infinity; }
  start(virtualMs, endMs) { this.anchorVirtual = virtualMs; this.anchorReal = Date.now(); this.endMs = endMs; this.paused = false; }
  now() {
    if (this.mode === 'live') return Date.now();
    if (this.paused) return this.frozen;
    return Math.min(this.endMs, this.anchorVirtual + (Date.now() - this.anchorReal) * this.speed);
  }
  setSpeed(x) { const n = this.now(); this.speed = x; this.anchorVirtual = n; this.anchorReal = Date.now(); }
  pause() { this.frozen = this.now(); this.paused = true; }
  resume() { this.paused = false; this.anchorVirtual = this.frozen; this.anchorReal = Date.now(); }
  finished() { return this.mode !== 'live' && this.now() >= this.endMs; }
}

module.exports = { YahooProvider, DemoProvider, Clock, yf, NAMES };
