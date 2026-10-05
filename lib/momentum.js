// Momentum book: a PAPER-ONLY monthly 12-1 momentum portfolio, independent of the opening-range engine.
// Rules (from swing-study.js, strategy M1):
//   - Once a month, on the first trading day (decision at 10:30 IST, any time up to 15:00), rank the Nifty 200 by the
//     12-month return skipping the latest month: close[-22] / close[-253] - 1, using completed daily bars only.
//   - Eligible: 20-day average turnover over Rs 30 crore, price under Rs 8,000, no one-day move over 35% in the last
//     year (corporate-action guard), at least 260 sessions of history.
//   - If Nifty's last close is below its 200-day average: sell everything and hold cash (regime OFF).
//   - Otherwise hold the top N (default 10) in equal rupee amounts. Holdings that stay in the top N are kept (the study
//     re-bought them every month; keeping them saves charges). Leavers are sold, entrants are bought with equity / N each.
//   - Delivery (CNC) charges, 0.05% slippage per side, no stops, no leverage.
// It has its own storage keys (paper-trader:mbook:*), its own timer, and never touches the engine. Any error is
// caught and logged here; it cannot reach the opening-range bot.
const fs = require('fs');
const path = require('path');
const { yf } = require('./data');
const { dayKey, minOfDay, isWeekday } = require('./time');

const SLIP = 0.0005;
const delivery = (side, v) => {
  const brk = Math.min(20, v * 0.0003), stt = v * 0.001, txn = v * 0.0000297, sebi = v * 0.000001, stamp = side === 'BUY' ? v * 0.00015 : 0;
  return brk + stt + txn + sebi + stamp + 0.18 * (brk + txn + sebi);
};
const sma = (a, end, n) => { let s = 0; for (let q = end - n; q < end; q++) s += a[q]; return s / n; };
function artifact(c, from, to) { for (let q = Math.max(1, from); q <= to; q++) if (Math.abs(c[q] / c[q - 1] - 1) > 0.35) return true; return false; }

// ---------------- pure rules (also used by momentum-sim.js and the tests) ----------------
// S[sym] = { d: ['YYYY-MM-DD'...], c: [closes...], v: [volumes...] } oldest first, COMPLETED sessions only. N likewise for Nifty.
function momentumPicks(S, N, slots) {
  const nx = N.c.length;
  const regimeOn = nx >= 201 && N.c[nx - 1] > sma(N.c, nx, 200);
  const eligible = [];
  for (const sym of Object.keys(S)) {
    const s = S[sym], x = s.c.length;
    if (x < 260 || s.d[x - 1] !== N.d[nx - 1]) continue; // too short, or no bar for the latest session
    let turn = 0; for (let q = x - 20; q < x; q++) turn += s.c[q] * s.v[q]; turn /= 20;
    if (turn < 3e8 || s.c[x - 1] > 8000 || artifact(s.c, x - 253, x - 1)) continue;
    eligible.push({ sym, mom: s.c[x - 22] / s.c[x - 253] - 1, last: s.c[x - 1], turn });
  }
  eligible.sort((a, b) => b.mom - a.mom);
  return { asOf: N.d[nx - 1], regimeOn, niftyClose: N.c[nx - 1], sma200: nx >= 200 ? sma(N.c, nx, 200) : null, eligibleCount: eligible.length, picks: eligible.slice(0, slots) };
}

function planOrders(positions, res, slots) {
  const usable = res.regimeOn && res.eligibleCount >= 20;
  const want = usable ? res.picks.map(p => p.sym) : [];
  const sells = positions.filter(p => !want.includes(p.sym)).map(p => ({ sym: p.sym, qty: p.qty, reason: !res.regimeOn ? 'Nifty is below its 200-day average, so cash' : !usable ? 'too few eligible stocks' : `no longer in the top ${slots}` }));
  const held = new Set(positions.map(p => p.sym));
  const buys = usable ? res.picks.map((p, i) => ({ sym: p.sym, mom: p.mom, rank: i + 1 })).filter(b => !held.has(b.sym)) : [];
  return { sells, buys };
}

// prices: { SYM: livePrice }. Mutates `book` ({cash, positions}); returns the trade records.
function executeOrders(book, plan, prices, slots, day, now) {
  const trades = [];
  for (const o of plan.sells) {
    const p = book.positions.find(q => q.sym === o.sym);
    const x = prices[o.sym] * (1 - SLIP), fee = delivery('SELL', p.qty * x), proceeds = p.qty * x - fee;
    book.cash += proceeds;
    book.positions = book.positions.filter(q => q !== p);
    trades.push({ day, t: now, side: 'SELL', sym: o.sym, qty: p.qty, price: x, fee, pnl: proceeds - p.cost, pnlPct: (proceeds / p.cost - 1) * 100, heldFrom: p.entryDay, reason: o.reason });
  }
  const equity = book.cash + book.positions.reduce((a, p) => a + p.qty * (prices[p.sym] || p.entry), 0);
  const budget = equity / slots;
  for (const o of plan.buys) {
    const ep = prices[o.sym] * (1 + SLIP);
    let qty = Math.floor(Math.min(budget, book.cash) / ep);
    while (qty > 0 && qty * ep + delivery('BUY', qty * ep) > book.cash) qty--;
    if (qty < 1) { trades.push({ day, t: now, side: 'SKIP', sym: o.sym, reason: 'not enough cash for one share' }); continue; }
    const fee = delivery('BUY', qty * ep), cost = qty * ep + fee;
    book.cash -= cost;
    book.positions.push({ sym: o.sym, qty, entry: ep, cost, entryDay: day, mom: o.mom, rank: o.rank });
    trades.push({ day, t: now, side: 'BUY', sym: o.sym, qty, price: ep, fee, rank: o.rank, mom: o.mom, reason: `rank ${o.rank} of ${slots} by 12-1 momentum (${(o.mom * 100).toFixed(0)}%)` });
  }
  return trades;
}

// ---------------- storage (own keys, never shared with the engine) ----------------
class Store {
  constructor(cfg) { this.cfg = cfg; this.dir = path.join(__dirname, '..', 'data'); }
  async redis(cmd) {
    const r = await fetch(this.cfg.upstashUrl, { method: 'POST', headers: { Authorization: 'Bearer ' + this.cfg.upstashToken }, body: JSON.stringify(cmd), signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status);
    return j.result;
  }
  async get(name) {
    if (this.cfg.upstashUrl) { const r = await this.redis(['GET', 'paper-trader:mbook:' + name]); return r ? JSON.parse(r) : null; }
    const f = path.join(this.dir, `mbook-${name}.json`);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  }
  async set(name, obj) {
    if (this.cfg.upstashUrl) { await this.redis(['SET', 'paper-trader:mbook:' + name, JSON.stringify(obj)]); return; }
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, `mbook-${name}.json`), JSON.stringify(obj));
  }
  async push(name, rec) {
    if (this.cfg.upstashUrl) { await this.redis(['RPUSH', 'paper-trader:mbook:' + name, JSON.stringify(rec)]); return; }
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(path.join(this.dir, `mbook-${name}.jsonl`), JSON.stringify(rec) + '\n');
  }
  async list(name) {
    if (this.cfg.upstashUrl) return (await this.redis(['LRANGE', 'paper-trader:mbook:' + name, 0, -1])).map(x => JSON.parse(x));
    const f = path.join(this.dir, `mbook-${name}.jsonl`);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
  }
}

// ---------------- live data (replaceable in tests) ----------------
const sleep = ms => new Promise(r => setTimeout(r, ms));
function liveData(cfg) {
  return {
    symbols: () => cfg.watchlist.slice(),
    // completed + (after the close) today's daily bars for one symbol
    async daily(sym, upToDay, includeToday) {
      const bars = await yf(sym, '1d', '2y', 3);
      const d = [], c = [], v = [];
      for (const b of bars) { const k = dayKey(b.t); if (k > upToDay || (k === upToDay && !includeToday)) continue; d.push(k); c.push(b.c); v.push(b.v); }
      return { d, c, v };
    },
    // latest traded price now
    async price(sym, day) {
      const bars = (await yf(sym, '5m', '1d', 3)).filter(b => dayKey(b.t) === day);
      if (!bars.length) throw new Error('no price for ' + sym);
      return bars[bars.length - 1].c;
    },
    async marketTraded(day) { const bars = (await yf(cfg.indexSymbol, '5m', '1d', 2)).filter(b => dayKey(b.t) === day); return bars.length > 0; }
  };
}

class MomentumBook {
  constructor(cfg, opts = {}) {
    this.cfg = cfg; this.slots = cfg.mbookSlots; this.store = opts.store || new Store(cfg); this.data = opts.data || liveData(cfg);
    this.state = null; this.running = false; this.tradedCache = {};
  }
  fresh() {
    return { v: 1, startCapital: this.cfg.mbookCapital, slots: this.slots, startedAt: Date.now(), startDay: null, startNifty: null, cash: this.cfg.mbookCapital, positions: [],
      lastRebalanceMonth: null, lastMarkDay: null, curve: [], preview: null, lastPrices: {}, lastNifty: null, recent: [], events: [], outbox: [] };
  }
  log(kind, text) { this.state.events.unshift({ t: Date.now(), kind, text }); if (this.state.events.length > 80) this.state.events.pop(); }
  async load() {
    try { this.state = (await this.store.get('state')) || this.fresh(); } catch (e) { console.error('Momentum book: load failed, starting fresh:', e.message); this.state = this.fresh(); }
    if (!this.state.outbox) this.state.outbox = [];
    console.log(`Momentum book ready: ${this.state.positions.length} position(s), cash ${this.state.cash.toFixed(0)}, last rebalance ${this.state.lastRebalanceMonth || 'never'}.`);
  }
  async save() {
    const st = this.state;
    while (st.outbox.length) {
      const o = st.outbox[0];
      try { await this.store.push(o.name, o.rec); st.outbox.shift(); } catch (e) { console.error('Momentum book: log write failed, will retry:', e.message); break; }
    }
    try { await this.store.set('state', st); } catch (e) { console.error('Momentum book: state save failed:', e.message); }
  }
  queue(name, rec) { this.state.outbox.push({ name, rec }); }

  async universe(day, includeToday) {
    const syms = this.data.symbols(), S = {};
    let N = null, i = 0;
    const worker = async () => {
      while (i < syms.length + 1) {
        const sym = i === 0 ? this.cfg.indexSymbol : syms[i - 1]; i++;
        try { const s = await this.data.daily(sym, day, includeToday); if (sym === this.cfg.indexSymbol) N = s; else S[sym] = s; } catch (e) { /* missing symbol is simply not ranked */ }
        await sleep(80);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (!N || N.c.length < 201) throw new Error('Nifty history not available');
    return { S, N };
  }

  async isTradingDay(day, mod) {
    if (this.tradedCache[day] !== undefined) return this.tradedCache[day];
    if (mod < 555 + 6) return false;
    let t = false;
    try { t = await this.data.marketTraded(day); } catch (e) { return false; }
    if (t || mod > 16 * 60) this.tradedCache[day] = t;
    return t;
  }

  async tick(now = Date.now()) {
    if (this.running || !this.state) return;
    this.running = true;
    try {
      if (!isWeekday(now)) return;
      const day = dayKey(now), mod = minOfDay(now), st = this.state, month = day.slice(0, 7);
      const needRebalance = st.lastRebalanceMonth !== month && mod >= this.cfg.mbookRebalanceMin && mod <= 15 * 60;
      const needMark = st.lastMarkDay !== day && mod >= 15 * 60 + 50;
      if (!needRebalance && !needMark) return;
      if (!(await this.isTradingDay(day, mod))) return;
      if (needRebalance) await this.rebalance(day, now);
      if (needMark) await this.evening(day, now);
    } catch (e) {
      console.error('Momentum book error:', e.message);
      if (this.state) this.log('warn', 'Error: ' + e.message);
    } finally { this.running = false; }
  }

  async rebalance(day, now) {
    const st = this.state, month = day.slice(0, 7);
    // Use last evening's prepared list when it is for the latest completed session; otherwise rebuild it (one-off).
    let res = null;
    if (st.preview && st.preview.asOf < day) {
      const n = await this.data.daily(this.cfg.indexSymbol, day, false);
      if (n.d[n.d.length - 1] === st.preview.asOf) res = st.preview;
    }
    if (!res) { const { S, N } = await this.universe(day, false); res = momentumPicks(S, N, this.slots); this.log('info', 'Rebuilt the pick list (no valid evening preview).'); }
    const plan = planOrders(st.positions, res, this.slots);
    const need = [...new Set([...plan.sells.map(o => o.sym), ...plan.buys.map(o => o.sym)])];
    const prices = {};
    for (const sym of need) prices[sym] = await this.data.price(sym, day); // a failed price aborts this attempt; the next tick retries
    for (const p of st.positions) if (!(p.sym in prices)) { try { prices[p.sym] = await this.data.price(p.sym, day); } catch (e) { prices[p.sym] = st.lastPrices[p.sym] || p.entry; } }
    const book = { cash: st.cash, positions: st.positions };
    const trades = executeOrders(book, plan, prices, this.slots, day, now);
    st.cash = book.cash; st.positions = book.positions; st.lastRebalanceMonth = month;
    for (const [s, px] of Object.entries(prices)) st.lastPrices[s] = px;
    for (const t of trades) { this.queue('trades', { ...t, regime: res.regimeOn, niftyClose: res.niftyClose, sma200: res.sma200, asOf: res.asOf }); st.recent.unshift(t); }
    if (st.recent.length > 60) st.recent.length = 60;
    this.log('plan', `Monthly rebalance for ${month}: regime ${res.regimeOn ? 'ON' : 'OFF (Nifty ' + res.niftyClose.toFixed(0) + ' below its 200-day average ' + (res.sma200 ? res.sma200.toFixed(0) : '?') + ')'}. ${trades.filter(t => t.side === 'SELL').length} sold, ${trades.filter(t => t.side === 'BUY').length} bought, ${st.positions.length} held, cash ${st.cash.toFixed(0)}.`);
    await this.save();
  }

  // After the close: mark the portfolio to market and prepare tomorrow's pick list from complete daily bars.
  async evening(day, now) {
    const st = this.state;
    const { S, N } = await this.universe(day, true);
    if (N.d[N.d.length - 1] !== day) return; // today's daily bar is not published yet; try again on the next tick
    const last = {};
    for (const p of st.positions) { const s = S[p.sym]; if (s && s.d[s.d.length - 1] === day) last[p.sym] = s.c[s.c.length - 1]; }
    for (const p of st.positions) if (!(p.sym in last)) last[p.sym] = st.lastPrices[p.sym] || p.entry;
    Object.assign(st.lastPrices, last);
    st.lastNifty = N.c[N.c.length - 1];
    const equity = st.cash + st.positions.reduce((a, p) => a + p.qty * last[p.sym], 0);
    if (!st.startDay) { st.startDay = day; st.startNifty = st.lastNifty; }
    const point = { day, eq: equity, cash: st.cash, nifty: st.lastNifty, held: st.positions.length };
    st.curve.push(point);
    this.queue('days', { ...point, positions: st.positions.map(p => ({ sym: p.sym, qty: p.qty, entry: p.entry, last: last[p.sym], mom: p.mom, rank: p.rank })) });
    st.preview = momentumPicks(S, N, this.slots);
    st.lastMarkDay = day;
    await this.save();
  }

  snapshot() {
    const st = this.state;
    if (!st) return { enabled: true, loading: true };
    const pos = st.positions.map(p => { const last = st.lastPrices[p.sym] || p.entry; return { sym: p.sym, qty: p.qty, entry: p.entry, entryDay: p.entryDay, rank: p.rank, mom: p.mom, last, value: p.qty * last, pnl: p.qty * last - p.cost, pnlPct: (p.qty * last / p.cost - 1) * 100 }; });
    const equity = st.cash + pos.reduce((a, p) => a + p.value, 0);
    const next = new Date(); next.setUTCDate(1); next.setUTCMonth(next.getUTCMonth() + 1);
    return {
      enabled: true, startCapital: st.startCapital, slots: st.slots, startDay: st.startDay, cash: st.cash, equity, pnl: equity - st.startCapital, pnlPct: (equity / st.startCapital - 1) * 100,
      niftyPct: st.startNifty && st.lastNifty ? (st.lastNifty / st.startNifty - 1) * 100 : null,
      positions: pos, preview: st.preview, lastRebalanceMonth: st.lastRebalanceMonth, lastMarkDay: st.lastMarkDay,
      nextRebalance: 'first trading day of ' + next.toISOString().slice(0, 7) + ' at ' + String(Math.floor(this.cfg.mbookRebalanceMin / 60)).padStart(2, '0') + ':' + String(this.cfg.mbookRebalanceMin % 60).padStart(2, '0'),
      curve: st.curve.slice(-400), recent: st.recent.slice(0, 30), events: st.events.slice(0, 25)
    };
  }
}

module.exports = { MomentumBook, momentumPicks, planOrders, executeOrders, delivery, SLIP };
