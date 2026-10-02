const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { dayKey, minOfDay, atMinute, isWeekday, OPEN, CLOSE } = require('./time');
const { avg, vwap, aggregate, volumeRatio } = require('./indicators');
const { analyzeDaily, pickStocks, buildTradePlan, r05 } = require('./planner');
const { tradeStats } = require('./stats');
const { buildPrompt, parseNews, parseVerdicts } = require('./news');
const { scoreSetup } = require('./score');
const { buildChecks, allPass, failed } = require('./checks');
const { checkNews } = require('./gemini');
const { NAMES, yf } = require('./data');
const { SCHEMA, BY_KEY, toDisplay, fromInput, validatePatch, crossCheck, captureDefaults, snapshot } = require('./settings');

// Approximate Indian intraday (MIS) equity charges per order. Check your broker's contract note for exact numbers.
function charges(side, value) {
  const brokerage = Math.min(20, value * 0.0003);
  const stt = side === 'SELL' ? value * 0.00025 : 0;
  const txn = value * 0.0000297;
  const sebi = value * 0.000001;
  const stamp = side === 'BUY' ? value * 0.00003 : 0;
  const gst = 0.18 * (brokerage + txn + sebi);
  return brokerage + stt + txn + sebi + stamp + gst;
}
const inr = n => n.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });

class Engine {
  constructor(cfg, provider, clock) {
    this.cfg = cfg; this.provider = provider; this.clock = clock; this.busy = false;
    this.settingsDefaults = captureDefaults(cfg);
    this.checkNews = checkNews; // replaceable in tests
    this.reset();
  }

  reset() {
    this.S = {
      day: null, now: 0, phase: 'starting', realized: 0, positions: [], closed: [], events: [], curve: [],
      watch: null, plans: {}, candles: {}, planBuilt: false, halted: false, tradesToday: 0,
      dayStartEquity: this.cfg.capital, error: null, retryAt: 0, seq: 0,
      newsDone: false, pendingReplacements: {}, risk: this.riskFrom(null, null),
      outbox: [], dayLogged: false, candlesSaved: false, needBackup: [], capital: this.cfg.capital
    };
  }

  // ---------------- survive restarts ----------------
  // Candles are not saved (they are re-fetched). Everything else is, so open positions, stops,
  // plans, news verdicts and the journal carry over a server restart. Stored in Upstash Redis
  // when UPSTASH_REDIS_REST_URL/TOKEN are set (survives Render redeploys), else in a local file.
  async redis(cmd) {
    const { upstashUrl, upstashToken } = this.cfg;
    const res = await fetch(upstashUrl, { method: 'POST', headers: { Authorization: 'Bearer ' + upstashToken }, body: JSON.stringify(cmd) });
    const j = await res.json();
    if (!res.ok || j.error) throw new Error(j.error || 'HTTP ' + res.status);
    return j.result;
  }

  async save() {
    const cfg = this.cfg;
    if (!cfg.upstashUrl && !cfg.stateFile) return;
    try {
      this.S.capital = cfg.capital;
      const { candles, ...rest } = this.S;
      const data = JSON.stringify(rest);
      const { now, curve, ...rest2 } = rest;
      const sig = JSON.stringify(rest2);
      if (sig === this.lastSaved && Date.now() - (this.lastSavedAt || 0) < 60000) return;
      if (sig === this.lastSaved && !curve.length) return;
      if (cfg.upstashUrl) await this.redis(['SET', cfg.stateKey, data]);
      else {
        fs.mkdirSync(path.dirname(cfg.stateFile), { recursive: true });
        fs.writeFileSync(cfg.stateFile + '.tmp', data);
        fs.renameSync(cfg.stateFile + '.tmp', cfg.stateFile);
      }
      this.lastSaved = sig; this.lastSavedAt = Date.now();
    } catch (e) { console.error('State save failed:', e.message); }
  }

  async load() {
    const cfg = this.cfg;
    try {
      let raw = null;
      if (cfg.upstashUrl) raw = await this.redis(['GET', cfg.stateKey]);
      else if (cfg.stateFile && fs.existsSync(cfg.stateFile)) raw = fs.readFileSync(cfg.stateFile, 'utf8');
      if (!raw) return false;
      const saved = JSON.parse(raw);
      this.S = { ...this.S, ...saved, candles: {}, error: null, retryAt: 0 };
      if (typeof saved.capital === 'number' && saved.capital !== cfg.capital) this.S.dayStartEquity += cfg.capital - saved.capital;
      this.S.capital = cfg.capital;
      console.log(`Restored state from ${cfg.upstashUrl ? 'Upstash Redis' : cfg.stateFile}: day ${this.S.day}, ${this.S.positions.length} open position(s), ${this.S.closed.length} closed trade(s).`);
      return true;
    } catch (e) { console.error('State load failed, starting fresh:', e.message); return false; }
  }

  // ---------------- settings screen ----------------
  async kvGet(name) {
    const cfg = this.cfg;
    if (cfg.upstashUrl) { const r = await this.redis(['GET', this.listKey(name)]); return r ? JSON.parse(r) : null; }
    const f = path.join(this.logDir(), name + '.json');
    return cfg.stateFile && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  }

  async kvSet(name, obj) {
    const cfg = this.cfg;
    if (cfg.upstashUrl) { await this.redis(['SET', this.listKey(name), JSON.stringify(obj)]); return; }
    if (!cfg.stateFile) return;
    fs.mkdirSync(this.logDir(), { recursive: true });
    fs.writeFileSync(path.join(this.logDir(), name + '.json'), JSON.stringify(obj, null, 1));
  }

  // Saved overrides beat the defaults in config.js. Called once at startup, before state is restored.
  async loadSettings() {
    try {
      const ov = await this.kvGet('settings');
      if (!ov) return;
      const capitalBefore = this.cfg.capital;
      let n = 0;
      for (const [k, v] of Object.entries(ov)) {
        const f = BY_KEY[k];
        if (!f) continue;
        try { this.cfg[k] = fromInput(f, toDisplay(f, v)); n++; } catch (e) { console.error('Ignored saved setting', k, e.message); }
      }
      this.S.dayStartEquity += this.cfg.capital - capitalBefore;
      this.S.capital = this.cfg.capital;
      console.log(`Loaded ${n} saved setting(s) from the Settings screen.`);
    } catch (e) { console.error('Settings load failed, using defaults:', e.message); }
  }

  settingsView() {
    const show = src => Object.fromEntries(SCHEMA.map(f => [f.key, toDisplay(f, src[f.key])]));
    return { schema: SCHEMA, values: show(this.cfg), defaults: show(this.settingsDefaults), persisted: this.canStore(), mode: this.cfg.mode, openPositions: this.S.positions.length };
  }

  setCapital(next) {
    const delta = next - this.cfg.capital;
    this.S.dayStartEquity += delta; // like a deposit: today's P&L and the loss limit are not disturbed
    this.cfg.capital = next; this.S.capital = next;
  }

  async saveSettings(changes) {
    const cfg = this.cfg;
    const { clean, errors } = validatePatch(changes);
    if (Object.keys(errors).length) { const e = new Error('Some values are not valid'); e.fields = errors; throw e; }
    crossCheck({ ...snapshot(cfg), ...clean });
    const changed = Object.keys(clean).filter(k => clean[k] !== cfg[k]);
    const log = changed.map(k => ({ t: Date.now(), day: this.S.day, key: k, from: cfg[k], to: clean[k], fromText: toDisplay(BY_KEY[k], cfg[k]), toText: toDisplay(BY_KEY[k], clean[k]), strategyVersion: cfg.strategyVersion, openPositions: this.S.positions.length }));
    for (const k of changed) { if (k === 'capital') this.setCapital(clean[k]); else cfg[k] = clean[k]; }
    const overrides = {};
    for (const f of SCHEMA) if (cfg[f.key] !== this.settingsDefaults[f.key]) overrides[f.key] = cfg[f.key];
    await this.kvSet('settings', overrides);
    for (const r of log) this.queue('settings-log', r);
    await this.flush();
    this.log('info', changed.length ? 'Settings changed: ' + log.map(r => `${r.key} ${r.fromText} -> ${r.toText}`).join(', ') : 'Settings saved, nothing changed.');
    return { changed, persisted: this.canStore() };
  }

  // ---------------- permanent analysis log ----------------
  // Every closed trade (with the full context it was entered in), one summary per trading day and
  // the day's 1-minute candles are kept forever, separate from the restart state above, so weeks
  // later you can see why trades won or lost and re-test changed rules on the same prices.
  canStore() { return !!(this.cfg.upstashUrl || this.cfg.stateFile); }
  logDir() { return path.dirname(this.cfg.stateFile || path.join(__dirname, '..', 'data', 'x')); }
  listKey(name) { return `${this.cfg.stateKey}:${name}`; }

  queue(name, rec) { if (this.canStore()) this.S.outbox.push({ name, rec }); }

  async flush() {
    const { outbox } = this.S;
    while (outbox.length) {
      const { name, rec } = outbox[0];
      try {
        if (this.cfg.upstashUrl) await this.redis(['RPUSH', this.listKey(name), JSON.stringify(rec)]);
        else { fs.mkdirSync(this.logDir(), { recursive: true }); fs.appendFileSync(path.join(this.logDir(), name + '.jsonl'), JSON.stringify(rec) + '\n'); }
        outbox.shift();
      } catch (e) { console.error('Log write failed, will retry:', e.message); return; }
    }
  }

  async readList(name) {
    if (this.cfg.upstashUrl) return (await this.redis(['LRANGE', this.listKey(name), 0, -1])).map(x => JSON.parse(x));
    const f = path.join(this.logDir(), name + '.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(x => JSON.parse(x)) : [];
  }

  async saveCandles(day, candles) {
    const compact = {};
    for (const [sym, arr] of Object.entries(candles)) if (arr && arr.length) compact[sym] = arr.map(k => [k.t, k.o, k.h, k.l, k.c, k.v]);
    if (!Object.keys(compact).length) return;
    const gz = zlib.gzipSync(JSON.stringify(compact));
    if (this.cfg.upstashUrl) await this.redis(['SET', this.listKey('candles:' + day), gz.toString('base64')]);
    else { fs.mkdirSync(this.logDir(), { recursive: true }); fs.writeFileSync(path.join(this.logDir(), `candles-${day}.json.gz`), gz); }
  }

  async readCandles(day) {
    let gz = null;
    if (this.cfg.upstashUrl) { const b = await this.redis(['GET', this.listKey('candles:' + day)]); gz = b && Buffer.from(b, 'base64'); }
    else { const f = path.join(this.logDir(), `candles-${day}.json.gz`); gz = fs.existsSync(f) ? fs.readFileSync(f) : null; }
    return gz ? JSON.parse(zlib.gunzipSync(gz)) : null;
  }

  configSnapshot() { return snapshot(this.cfg); }

  // One record per trading day: what was watched, what was rejected and why, the market backdrop and how every plan ended.
  logDay() {
    const S = this.S;
    if (S.dayLogged) return;
    S.dayLogged = true;
    if (!S.day || !S.watch) return;
    const idx = S.candles[this.cfg.indexSymbol] || [];
    const trades = S.closed.filter(c => dayKey(c.tIn) === S.day);
    this.queue('days', {
      day: S.day, strategyVersion: this.cfg.strategyVersion, config: this.configSnapshot(),
      indexBias: S.watch.index ? S.watch.index.bias : null, indexDayChgPct: idx.length ? (idx[idx.length - 1].c / idx[0].o - 1) * 100 : null,
      vix: S.risk.vix, risk: S.risk, news: (() => { const { prompt, ...rest } = S.watch.news || {}; return rest; })(), replacementNews: S.watch.replacementNews || [],
      analyzed: S.watch.analyzed, picked: S.watch.picked, rejected: S.watch.rejected.slice(0, 80), backupsLeft: S.watch.backups.length,
      plans: Object.values(S.plans), halted: S.halted, tradesToday: S.tradesToday,
      tradeCount: trades.length, net: trades.reduce((a, t) => a + t.net, 0), fees: trades.reduce((a, t) => a + t.fees, 0),
      startEquity: S.dayStartEquity, endEquity: this.equity(),
      events: S.events.filter(e => dayKey(e.t) === S.day).slice().reverse()
    });
  }

  log(kind, text) {
    this.S.events.unshift({ t: this.S.now, kind, text });
    if (this.S.events.length > 150) this.S.events.pop();
  }

  lastPrice(sym) {
    const c = this.S.candles[sym];
    return c && c.length ? c[c.length - 1].c : null;
  }

  equity() {
    const S = this.S;
    let unreal = 0;
    for (const p of S.positions) {
      const lp = this.lastPrice(p.sym);
      if (lp != null) unreal += (lp - p.entry) * (p.side === 'long' ? 1 : -1) * p.qty;
    }
    return this.cfg.capital + S.realized + unreal;
  }

  newDay(day) {
    const S = this.S;
    if (S.positions.length) {
      for (const p of S.positions.slice()) this.closePos(p, p.entry, 'Session ended', S.now);
    }
    if (S.day) {
      this.logDay();
      if (!S.candlesSaved && this.canStore()) this.saveCandles(S.day, S.candles).catch(e => console.error('Candle save failed:', e.message));
    }
    S.day = day; S.watch = null; S.plans = {}; S.candles = {}; S.planBuilt = false;
    S.halted = false; S.tradesToday = 0; S.dayStartEquity = this.equity(); S.retryAt = 0;
    S.newsDone = false; S.pendingReplacements = {}; S.risk = this.riskFrom(null, null);
    S.dayLogged = false; S.candlesSaved = false; S.needBackup = [];
  }

  // ---------------- morning plan ----------------
  async preMarket(day) {
    const S = this.S, cfg = this.cfg;
    const infos = [], failed = [];
    const list = cfg.watchlist.slice();
    let i = 0;
    const worker = async () => {
      while (i < list.length) {
        const sym = list[i++];
        try {
          const d = await this.provider.daily(sym, day);
          const info = analyzeDaily(sym, d);
          if (info) infos.push(info); else failed.push({ sym, why: 'not enough history' });
        } catch (e) { failed.push({ sym, why: e.message }); }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (!infos.length) {
      S.retryAt = Date.now() + 15000;
      throw new Error(`Could not load daily prices (${failed[0] ? failed[0].why : 'unknown error'}). Retrying in 15s. Try MODE=demo to test offline.`);
    }
    const poolSize = cfg.shortlistSize + cfg.backupPoolSize;
    const { picked: pool, rejected } = pickStocks(infos, { ...cfg, shortlistSize: poolSize }, this.equity());
    let index = null;
    try { index = analyzeDaily(cfg.indexSymbol, await this.provider.daily(cfg.indexSymbol, day)); } catch (e) { /* optional */ }
    let vix = null;
    try { const vd = await this.provider.daily(cfg.vixSymbol, day); if (vd.length) vix = vd[vd.length - 1].c; } catch (e) { /* optional */ }
    S.risk = this.riskFrom(vix, null);
    S.watch = { day, pool, picked: pool.slice(0, cfg.shortlistSize), backups: pool.slice(cfg.shortlistSize), rejected, failed, analyzed: infos.length, index, news: { status: cfg.newsGuard ? 'pending' : 'off' } };
    S.newsDone = !cfg.newsGuard;
    const list2 = S.watch.picked.map(p => `${p.sym} (${p.bias})`).join(', ');
    this.log('plan', `Morning plan ready for ${day}. Shortlist: ${list2 || 'none'}.` + (index ? ` Nifty daily trend: ${index.bias}.` : '') + (S.risk.notes.length ? ` ${S.risk.notes.join('. ')}.` : ''));
  }

  // How much to risk today, from India VIX (previous close) and the news screen's market verdict.
  riskFrom(vix, newsRisk) {
    const cfg = this.cfg;
    let mult = 1, maxPositions = cfg.maxPositions;
    const notes = [];
    if (vix != null) {
      if (vix >= cfg.vixHigh) { mult = Math.min(mult, 0.5); notes.push(`India VIX ${vix.toFixed(1)} is very high, risk cut to 50%`); }
      else if (vix >= cfg.vixElevated) { mult = Math.min(mult, 0.75); notes.push(`India VIX ${vix.toFixed(1)} is elevated, risk cut to 75%`); }
      else notes.push(`India VIX ${vix.toFixed(1)} is normal`);
    }
    if (newsRisk === 'high') { mult = Math.min(mult, 0.5); maxPositions = Math.min(maxPositions, 2); notes.push('High-risk event day: risk cut to 50%, max 2 positions'); }
    else if (newsRisk === 'elevated') { mult = Math.min(mult, 0.75); notes.push('Elevated event risk: risk cut to 75%'); }
    return { mult, maxPositions, vix, newsRisk, notes };
  }

  geminiKey() { return process.env.GEMINI_API_KEY || process.env.LLM_API_KEY_FREE || ''; }
  autoNewsOn() { return this.cfg.newsGuard && this.cfg.newsAuto && !!this.geminiKey(); }
  names(symbols) { return Object.fromEntries(symbols.map(s => [s, NAMES.get(s)]).filter(([, n]) => n)); }

  // Anything that could not be verified is treated by policy: "block" (default) never assumes safe.
  isAvoided(verdict) { return verdict === false || (verdict === null && this.cfg.unverifiedPolicy === 'block'); }

  async newsStep() {
    const S = this.S;
    if (S.newsDone) return;
    if (this.autoNewsOn()) { await this.runAutoNews(); if (S.newsDone) return; }
    if (!S.watch.news || S.watch.news.status !== 'manual-pending') {
      const prev = S.watch.news || {};
      const symbols = S.watch.picked.map(p => p.sym);
      S.watch.news = { status: 'manual-pending', prompt: buildPrompt(symbols, S.now, true, this.names(symbols)), error: prev.error || null, autoFailedAt: prev.autoFailedAt || 0 };
    }
  }

  // Automatic check: we fetch the headlines, Gemini classifies them. Any failure falls back to the
  // manual box with the error shown, and the check is retried every 5 minutes (or on the Retry button).
  async runAutoNews() {
    const S = this.S;
    if (this.newsRunning) return;
    const prev = S.watch.news || {};
    if (prev.autoFailedAt && Date.now() - prev.autoFailedAt < 300000) return;
    this.newsRunning = true;
    const symbols = S.watch.picked.map(p => p.sym);
    try {
      const res = await this.checkNews({ symbols, names: this.names(symbols), nowMs: S.now || Date.now(), cfg: this.cfg, key: this.geminiKey() });
      const stocks = Object.fromEntries(Object.entries(res.stocks).map(([sym, d]) => [sym, d]));
      this.applyNews({ stocks, market: res.market.risk, marketSummary: res.market.summary, marketSources: res.market.sources, source: 'gemini', model: res.model, windowHours: res.windowHours });
    } catch (err) {
      S.watch.news = { status: 'manual-pending', prompt: buildPrompt(symbols, S.now, true, this.names(symbols)), error: 'Automatic news check failed: ' + err.message + '. Use the manual paste below, or retry.', autoFailedAt: Date.now() };
      this.log('warn', 'Automatic news check failed (' + err.message + '). Manual paste needed; stocks are not assumed safe.');
    } finally { this.newsRunning = false; }
  }

  retryAutoNews() {
    const S = this.S;
    if (S.watch && S.watch.news) S.watch.news.autoFailedAt = 0;
  }

  // Common end point for a news result, manual or automatic. stocks[sym].block: true = avoid, false = clear, null = unverified.
  applyNews({ stocks, market, marketSummary, marketSources, source, model, windowHours }) {
    const S = this.S, cfg = this.cfg;
    const verdicts = {}, avoided = [], unverified = [];
    for (const info of S.watch.picked.slice()) {
      const d = stocks[info.sym] || { block: null, verified: false, reason: 'Not in the reply.', sources: [] };
      verdicts[info.sym] = d.block === null ? null : !d.block;
      if (d.block === null) unverified.push(info.sym);
      if (this.isAvoided(verdicts[info.sym])) {
        avoided.push(info.sym);
        S.plans[info.sym] = { sym: info.sym, bias: info.bias, status: 'skipped', note: d.block === null ? 'Not verified by the news check, so not traded.' : 'Avoided by news check.', avoided: true, replaceStarted: true, or: null, gapPct: 0, legs: {}, lastConsidered: 0 };
        this.tryNextBackup(info.sym);
      }
    }
    const known = ['normal', 'elevated', 'high'].includes(market);
    const effective = known ? (market === 'normal' ? null : market) : (cfg.unverifiedPolicy === 'block' ? 'elevated' : null);
    S.risk = this.riskFrom(S.risk.vix, effective);
    S.watch.news = { status: 'ok', source, model: model || null, windowHours: windowHours || null, verdicts, avoided, unverified, market: known ? market : 'unknown', marketEffective: effective || 'normal', marketSummary: marketSummary || '', marketSources: marketSources || [], details: stocks, at: S.now };
    S.newsDone = true;
    this.log('plan', `News check applied (${source}${model ? ', ' + model : ''}). Market risk: ${known ? market : 'not verified'}${effective ? ' (' + S.risk.notes[S.risk.notes.length - 1] + ')' : ''}.${avoided.length ? ' Not traded: ' + avoided.join(', ') + (unverified.length ? ' (unverified: ' + unverified.join(', ') + ')' : '') + ', looking for a backup.' : ' Nothing avoided.'}`);
  }

  // Called from the dashboard once you paste the AI's reply for today's shortlist.
  applyManualNews(text) {
    const S = this.S;
    if (!S.watch) throw new Error('Morning plan not ready yet');
    const symbols = S.watch.picked.map(p => p.sym);
    const { verdicts, market } = parseNews(text, symbols);
    const stocks = Object.fromEntries(symbols.map(sym => [sym, { block: verdicts[sym] === null ? null : !verdicts[sym], verified: verdicts[sym] !== null, reason: verdicts[sym] === null ? 'Missing or not true/false in the pasted reply.' : 'From the pasted reply.', sources: [] }]));
    this.applyNews({ stocks, market, source: 'manual' });
  }

  skipNews() {
    const S = this.S, cfg = this.cfg;
    if (cfg.newsRequired) throw new Error('NEWS_REQUIRED is set, the news check cannot be skipped');
    if (!S.watch) throw new Error('Morning plan not ready yet');
    S.watch.news = { status: 'skipped', at: S.now };
    S.newsDone = true;
    this.log('plan', 'News check skipped for today.');
  }

  // ---------------- replacing a dead stock with the next-best backup ----------------
  // Called once a picked stock is avoided by news, or its setup dies with no trade (topUp()).
  // The slot is queued here and filled by fillSlots() (async, because backups are checked against
  // today's prices first). Past replaceUntilMin the slot is left empty: a late backup's setup is
  // usually dead already.
  tryNextBackup(slotSym) {
    const S = this.S, cfg = this.cfg;
    if (S.planBuilt && minOfDay(S.now) > cfg.replaceUntilMin) {
      this.log('warn', `${slotSym}: slot left empty, it is past ${Math.floor(cfg.replaceUntilMin / 60)}:${String(cfg.replaceUntilMin % 60).padStart(2, '0')} when backups are no longer tried.`);
      return;
    }
    if (!S.needBackup.includes(slotSym)) S.needBackup.push(slotSym);
  }

  // A backup is "dead on arrival" if, by the time we pick it, its price already hit the stop or
  // target level, or already broke out, since the opening range. Returns a reason, or null if usable.
  async screenBackup(info) {
    const S = this.S, cfg = this.cfg;
    if (!S.planBuilt) return null;
    let c1;
    try { c1 = await this.provider.intraday(info.sym, S.day); } catch (e) { return null; }
    if (!c1 || !c1.length) return null;
    const plan = buildTradePlan(info, c1, { ...cfg, riskPct: cfg.riskPct * S.risk.mult }, this.equity());
    if (!plan) return 'no opening-range data';
    if (plan.status !== 'waiting') return plan.note || 'no valid setup';
    const lastT = c1[c1.length - 1].t;
    const done = aggregate(c1, 5).filter(k => k.t + 300000 <= lastT + 60000 && minOfDay(k.t) >= OPEN + cfg.orMinutes);
    for (const leg of Object.values(plan.legs)) {
      if (leg.status !== 'waiting') continue;
      const long = leg.side === 'long';
      const dead = done.some(k => (long ? k.l <= leg.sl || k.h >= leg.tp || k.c > leg.trigger : k.h >= leg.sl || k.l <= leg.tp || k.c < leg.trigger));
      if (!dead) return null;
    }
    return 'setup already dead (price hit the stop, target or breakout level earlier)';
  }

  async fillSlots() {
    const S = this.S, cfg = this.cfg;
    if (!S.watch || !S.needBackup.length) return;
    const slots = S.needBackup.splice(0);
    for (const slot of slots) {
      const found = [], dead = [];
      while (found.length < cfg.replaceCandidates && S.watch.backups.length) {
        const next = S.watch.backups.shift();
        const why = await this.screenBackup(next);
        if (why) dead.push(next.sym); else found.push(next);
      }
      if (dead.length) this.log('plan', `${slot}: skipped dead backups ${dead.join(', ')} (setup already failed today).`);
      if (!found.length) { this.log('warn', `${slot}: no usable backup stock left today.`); continue; }
      if (!cfg.newsGuard) { this.promoteBackup(slot, found[0]); S.watch.backups.unshift(...found.slice(1)); continue; }
      if (this.autoNewsOn()) {
        try {
          const syms = found.map(c => c.sym);
          const res = await this.checkNews({ symbols: syms, names: this.names(syms), nowMs: S.now || Date.now(), cfg, key: this.geminiKey(), withMarket: false });
          if (!S.watch.replacementNews) S.watch.replacementNews = [];
          S.watch.replacementNews.push({ at: S.now, slot, model: res.model, stocks: res.stocks });
          const verdictOf = c => { const d = res.stocks[c.sym]; return !d || d.block === null ? null : !d.block; };
          const rejected = found.filter(c => this.isAvoided(verdictOf(c))).map(c => c.sym);
          if (rejected.length) this.log('plan', `${slot}: backups not traded after the news check: ${rejected.join(', ')}.`);
          const pick = found.findIndex(c => !this.isAvoided(verdictOf(c)));
          if (pick < 0) { this.tryNextBackup(slot); continue; }
          S.watch.backups.unshift(...found.slice(pick + 1));
          this.promoteBackup(slot, found[pick]);
          continue;
        } catch (err) { this.log('warn', `Automatic news check for ${slot}'s backups failed (${err.message}). Manual paste needed; they are not assumed safe.`); }
      }
      S.pendingReplacements[slot] = { candidates: found, at: S.now };
      this.log('plan', `${slot}: slot died. Queued backups ${found.map(c => c.sym).join(', ')} for the news check.`);
    }
  }

  promoteBackup(slotSym, info) {
    const S = this.S;
    const idx = S.watch.picked.findIndex(p => p.sym === slotSym);
    if (idx >= 0) S.watch.picked[idx] = info; else S.watch.picked.push(info);
    S.plans[info.sym] = { sym: info.sym, bias: info.bias, status: 'pending-data', promotedAt: S.now, fromBackup: true, replacedSlot: slotSym, note: 'Loading price data for the replacement pick.', or: null, gapPct: 0, legs: {}, lastConsidered: 0 };
    this.log('plan', `${info.sym} takes ${slotSym}'s slot. Watching for entry once its data loads.`);
  }

  // One prompt covering the backup candidates of every dead slot.
  pendingPrompt() {
    const S = this.S;
    const syms = Object.values(S.pendingReplacements).flatMap(p => p.candidates.map(c => c.sym));
    return syms.length ? buildPrompt(syms, S.now, false, this.names(syms)) : null;
  }

  // Called from the dashboard once you paste the AI's reply for all queued backups. Each dead slot
  // takes its first backup not marked false. Approved-but-unused backups go back on the bench.
  applyReplacementsNews(text) {
    const S = this.S;
    const slots = Object.keys(S.pendingReplacements);
    if (!slots.length) throw new Error('No pending replacements');
    const verdicts = parseVerdicts(text, slots.flatMap(sl => S.pendingReplacements[sl].candidates.map(c => c.sym)));
    for (const slot of slots) {
      const { candidates } = S.pendingReplacements[slot];
      delete S.pendingReplacements[slot];
      const i = candidates.findIndex(c => !this.isAvoided(verdicts[c.sym]));
      const avoided = candidates.slice(0, i < 0 ? candidates.length : i).map(c => c.sym);
      if (avoided.length) this.log('plan', `${avoided.join(', ')} avoided by news for ${slot}'s slot.`);
      if (i < 0) { this.tryNextBackup(slot); continue; }
      S.watch.backups.unshift(...candidates.slice(i + 1));
      this.promoteBackup(slot, candidates[i]);
    }
  }

  skipReplacementsNews() {
    const S = this.S;
    if (this.cfg.newsRequired) throw new Error('NEWS_REQUIRED is set, the news check cannot be skipped');
    for (const slot of Object.keys(S.pendingReplacements)) {
      const { candidates } = S.pendingReplacements[slot];
      delete S.pendingReplacements[slot];
      S.watch.backups.unshift(...candidates.slice(1));
      this.promoteBackup(slot, candidates[0]);
    }
  }

  // Finds picked stocks whose setup died today with no trade, and starts replacing them.
  topUp(mod) {
    const S = this.S, cfg = this.cfg;
    if (S.halted || mod + 5 > cfg.lastEntryMin) return;
    for (const info of S.watch.picked) {
      const plan = S.plans[info.sym];
      if (!plan || plan.status !== 'skipped' || plan.replaceStarted) continue;
      plan.replaceStarted = true;
      if (S.pendingReplacements[info.sym]) continue;
      this.tryNextBackup(info.sym);
    }
  }

  buildPlanFor(info) {
    const S = this.S, cfg = this.cfg;
    const eq = this.equity();
    const effCfg = { ...cfg, riskPct: cfg.riskPct * S.risk.mult };
    const c1 = S.candles[info.sym] || [];
    const plan = buildTradePlan(info, c1, effCfg, eq)
      || { sym: info.sym, bias: info.bias, status: 'skipped', note: 'No opening-range data', or: null, gapPct: 0, legs: {}, lastConsidered: 0 };
    plan.builtAt = S.now;
    S.plans[info.sym] = plan;
    if (plan.status === 'waiting') {
      const txt = Object.values(plan.legs).filter(l => l.status === 'waiting')
        .map(l => `${l.side === 'long' ? 'buy above' : 'short below'} ${inr(l.trigger)} (stop ${inr(l.sl)}, target ${inr(l.tp)}, qty ${l.qty})`).join('; ');
      this.log('plan', `${info.sym}: ${txt}`);
    } else this.log('plan', `${info.sym}: skipped. ${plan.note}`);
    return plan;
  }

  buildPlans() {
    const S = this.S;
    for (const info of S.watch.picked) {
      if (S.plans[info.sym] && S.plans[info.sym].avoided) continue;
      this.buildPlanFor(info);
    }
    S.planBuilt = true;
  }

  // ---------------- main loop step ----------------
  async poll() {
    if (this.busy) return;
    this.busy = true;
    try { await this._poll(); this.S.error = null; }
    catch (e) { this.S.error = e.message; }
    finally { this.busy = false; await this.flush(); await this.save(); }
  }

  async _poll() {
    const S = this.S, cfg = this.cfg;
    const now = this.clock.now(), day = dayKey(now), mod = minOfDay(now);
    if (S.day !== day) this.newDay(day);
    S.now = now;
    if (S.retryAt && Date.now() < S.retryAt) return;
    if (!S.watch) await this.preMarket(day);
    await this.newsStep();
    await this.fillSlots();
    await this.loadBaseline();
    if (S.retryAt && Date.now() < S.retryAt) return;
    if (cfg.mode === 'live' && !isWeekday(now)) { S.phase = 'weekend'; return; }
    if (mod < OPEN) { S.phase = 'pre-market'; return; }
    if (!S.newsDone) { S.phase = 'waiting-news'; return; }

    const syms = [cfg.indexSymbol, ...S.watch.picked.map(p => p.sym)];
    const got = await Promise.all(syms.map(s => this.provider.intraday(s, day).then(c => [s, c]).catch(e => { S.error = e.message; return [s, S.candles[s] || []]; })));
    for (const [s, c] of got) S.candles[s] = c;
    if (!(S.candles[cfg.indexSymbol] || []).length) { S.phase = mod > OPEN + 10 ? 'no-data' : 'opening'; return; }

    if (mod >= OPEN + cfg.orMinutes && !S.planBuilt) this.buildPlans();
    if (S.planBuilt) {
      for (const info of S.watch.picked) {
        const plan = S.plans[info.sym];
        if (plan && plan.status === 'pending-data' && (S.candles[info.sym] || []).length) this.buildPlanFor(info);
      }
      this.topUp(mod);
    }
    this.processEntries(mod);
    this.managePositions(now);

    const sqT = atMinute(day, cfg.squareOffMin);
    if (now >= sqT && S.positions.length) this.squareOff(sqT, 'Square-off');

    const dayPnl = this.equity() - S.dayStartEquity;
    if (!S.halted && dayPnl <= -(cfg.capital * cfg.dailyLossPct) / 100) {
      this.closeAll('Daily loss limit', now);
      S.halted = true;
      this.log('warn', `Daily loss limit of ${cfg.dailyLossPct}% reached. No new trades today.`);
    }

    if (mod >= CLOSE && !S.positions.length) {
      this.logDay();
      if (!S.candlesSaved && this.canStore()) { await this.saveCandles(S.day, S.candles); S.candlesSaved = true; }
    }
    if (mod >= CLOSE) S.phase = 'closed';
    else if (mod >= cfg.squareOffMin) S.phase = 'square-off';
    else if (S.halted) S.phase = 'halted';
    else if (mod < OPEN + cfg.orMinutes) S.phase = 'opening-range';
    else if (mod > cfg.lastEntryMin) S.phase = 'no-new-trades';
    else S.phase = 'trading';

    S.curve.push({ t: now, e: this.equity() });
    if (S.curve.length > 3000) S.curve = S.curve.filter((_, i) => i % 2 === 0);
  }

  // Study-only volume baseline for the shortlist and backups: for each 5-minute slot, the average volume
  // of that slot (and of the whole morning up to it) over up to 20 earlier sessions. Needs at least 10 sessions.
  // It never affects a trade decision; it is saved with every signal so volume rules can be tested later.
  async loadBaseline() {
    const S = this.S;
    if (this.cfg.mode === 'demo' || !S.watch) return;
    if (!this._base || this._base.day !== S.day) this._base = { day: S.day, bySym: {}, tried: new Set() };
    const B = this._base;
    const todo = (S.watch.pool || []).map(p => p.sym).filter(sym => !B.tried.has(sym));
    for (const sym of todo) B.tried.add(sym);
    let i = 0;
    const worker = async () => {
      while (i < todo.length) {
        const sym = todo[i++];
        try {
          const bars = await yf(sym, '5m', '1mo', 2);
          const days = {};
          for (const c of bars) if (dayKey(c.t) < S.day) (days[dayKey(c.t)] = days[dayKey(c.t)] || []).push(c);
          const hist = Object.keys(days).sort().slice(-20).map(d => days[d]).filter(a => a.length >= 70);
          if (hist.length < 10) continue;
          const slots = {};
          for (let k = 0; k < 75; k++) slots[OPEN + k * 5] = { slot: avg(hist.map(a => (a[k] ? a[k].v : 0))), cum: avg(hist.map(a => a.slice(0, k + 1).reduce((x, c) => x + c.v, 0))), sessions: hist.length };
          B.bySym[sym] = slots;
        } catch (e) { /* study-only, ignore */ }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  // ---------------- entries ----------------
  processEntries(mod) {
    const S = this.S, cfg = this.cfg;
    if (S.halted || !S.planBuilt) return;
    const pending = [];
    for (const plan of Object.values(S.plans)) {
      if (plan.status !== 'waiting') continue;
      const c1 = S.candles[plan.sym];
      if (!c1 || !c1.length) continue;
      const lastT = c1[c1.length - 1].t;
      const done = aggregate(c1, 5).filter(b => b.t + 300000 <= lastT + 60000);
      done.forEach((b, i) => {
        if (minOfDay(b.t) < OPEN + cfg.orMinutes || b.t <= plan.lastConsidered) return;
        pending.push({ plan, c1, b, done: done.slice(0, i + 1), isLatest: i === done.length - 1, lastT });
      });
    }
    pending.sort((x, y) => x.b.t - y.b.t);
    for (const ev of pending) {
      const { plan, b } = ev;
      if (plan.status !== 'waiting') continue;
      plan.lastConsidered = b.t;
      if (minOfDay(b.t) + 5 > cfg.lastEntryMin) continue;
      if (S.positions.length >= S.risk.maxPositions || S.tradesToday >= cfg.maxTradesPerDay) continue;
      this.evaluate(ev);
    }
  }

  // Records why a setup did NOT trade (or died) so failures can be studied later, not just trades.
  block(plan, leg, code, b, extra) {
    if (!plan.blocks) plan.blocks = [];
    if (plan.blocks.length < 40) plan.blocks.push({ t: b.t, side: leg.side, code, ...this._snap, ...extra });
  }

  evaluate(ev) {
    const S = this.S, cfg = this.cfg;
    const { plan, c1, b, done, isLatest, lastT } = ev;
    const endT = b.t + 300000;
    const vw = vwap(c1.filter(k => k.t < endT));
    const avgVol = avg(done.map(x => x.v));
    const volRatio = volumeRatio(done);
    const bl = this._base && this._base.day === S.day && this._base.bySym[plan.sym] ? this._base.bySym[plan.sym][minOfDay(b.t)] : null;
    const cumVol = done.reduce((a, x) => a + x.v, 0);
    const rvolSlot = bl && bl.slot > 0 ? b.v / bl.slot : null, rvolCum = bl && bl.cum > 0 ? cumVol / bl.cum : null;
    const idx = (S.candles[cfg.indexSymbol] || []).filter(k => k.t < endT);
    const idxState = idx.length ? (idx[idx.length - 1].c > vwap(idx) ? 'up' : 'down') : 'unknown';

    const news = S.watch.news || {};
    this._snap = { decidedAt: endT, close: b.c, vwap: vw, volRatio, niftyState: idxState, orHigh: plan.or ? plan.or.hi : null, orLow: plan.or ? plan.or.lo : null, newsVerdict: news.verdicts ? news.verdicts[plan.sym] : null, newsMarket: news.market || null };
    for (const side of ['long', 'short']) {
      const leg = plan.legs[side];
      if (!leg || leg.status !== 'waiting') continue;
      const dir = side === 'long' ? 1 : -1;
      const refE = isLatest ? c1[c1.length - 1].c : b.c;
      const chaseE = (Math.abs(refE - leg.trigger) / leg.trigger) * 100;
      const deadWhy = dir === 1
        ? (b.l <= leg.sl && b.c < leg.trigger ? 'price reached the stop level before a breakout' : b.h >= leg.tp ? 'price reached the target level without a valid entry' : null)
        : (b.h >= leg.sl && b.c > leg.trigger ? 'price reached the stop level before a breakout' : b.l <= leg.tp ? 'price reached the target level without a valid entry' : null);
      const checks = buildChecks({ side, leg, cfg, price: b.c, vwap: vw, volRatio, idxState, chasePct: chaseE, deadWhy, positions: S.positions.length, trades: S.tradesToday, maxPositions: S.risk.maxPositions, mod: minOfDay(endT), live: false });
      leg.lastEval = { at: endT, price: b.c, allOk: allPass(checks), failed: failed(checks), checks };
      const info = S.watch.picked.find(p => p.sym === plan.sym) || null;
      const niftyOpen = idx.length ? (S.candles[cfg.indexSymbol] || [])[0].o : null;
      const stockChg = (b.c / c1[0].o - 1) * 100, niftyChg = niftyOpen && idx.length ? (idx[idx.length - 1].c / niftyOpen - 1) * 100 : null;
      const relStrength = niftyChg == null ? null : (stockChg - niftyChg) * dir;
      const prevDayBreak = info ? (dir === 1 ? b.c > info.prevHigh : b.c < info.prevLow) : null;
      const niftyAgrees = idxState === 'unknown' ? null : idxState === (dir === 1 ? 'up' : 'down');
      const setupScore = scoreSetup({ dir, planBias: plan.bias, volRatio, relStrength, prevDayBreak, niftyAgrees });
      // Every candle that broke the level is logged forever with ALL conditions, accepted or not.
      let sigRec = null;
      if (checks.find(c => c.key === 'breakout').ok === true) {
        sigRec = {
          day: S.day, decidedAt: endT, sym: plan.sym, side, strategyVersion: cfg.strategyVersion,
          price: b.c, trigger: leg.trigger, stop: leg.sl, target: leg.tp, vwap: vw, volRatio, rvolSlot, rvolCum, gapPct: plan.gapPct, niftyState: idxState, chasePct: chaseE,
          conditions: Object.fromEntries(checks.map(c => [c.key, c.ok])),
          final: allPass(checks) ? 'ENTERED' : 'REJECTED', failed: failed(checks),
          planBias: plan.bias, newsVerdict: news.verdicts ? news.verdicts[plan.sym] : null, newsMarket: news.market || null,
          relStrengthPct: relStrength, prevDayBreak, shortlistRank: info ? S.watch.picked.indexOf(info) + 1 : null, fromBackup: !!plan.fromBackup,
          setupScore: { score: setupScore.score, grade: setupScore.grade, parts: setupScore.parts }
        };
        this.queue('signals', sigRec);
      }
      // setup already dead?
      if (dir === 1 ? b.l <= leg.sl && b.c < leg.trigger : b.h >= leg.sl && b.c > leg.trigger) { leg.status = 'expired'; leg.note = 'Price moved to the stop level before a breakout. Setup failed.'; this.block(plan, leg, 'stop-level-hit-before-breakout', b, { high: b.h, low: b.l, sl: leg.sl }); continue; }
      if (dir === 1 ? b.h >= leg.tp : b.l <= leg.tp) { leg.status = 'expired'; leg.note = 'Price reached the target level without a valid entry. Missed.'; this.block(plan, leg, 'target-hit-before-entry', b, { high: b.h, low: b.l, tp: leg.tp }); continue; }
      if (!(dir === 1 ? b.c > leg.trigger : b.c < leg.trigger)) continue;

      if (!(dir === 1 ? b.c > vw : b.c < vw)) { leg.note = 'Broke the level but on the wrong side of VWAP. Waiting.'; this.block(plan, leg, 'wrong-side-of-vwap', b, { close: b.c, vwap: vw }); continue; }
      if (volRatio < cfg.minVolRatio) { leg.note = `Broke the level on weak volume (${volRatio.toFixed(2)}x average). Waiting.`; this.block(plan, leg, 'weak-volume', b, { volRatio, min: cfg.minVolRatio }); continue; }
      if (cfg.useIndexFilter && idxState !== 'unknown' && idxState !== (dir === 1 ? 'up' : 'down')) { leg.note = `Nifty is ${idxState} against a ${side} trade. Waiting.`; this.block(plan, leg, 'nifty-against', b, { niftyState: idxState }); continue; }
      const ref = isLatest ? c1[c1.length - 1].c : b.c;
      const chase = (Math.abs(ref - leg.trigger) / leg.trigger) * 100;
      if (chase > cfg.maxChasePct) { leg.note = `Price already ${chase.toFixed(2)}% past the trigger. Not chasing.`; this.block(plan, leg, 'chasing', b, { chasePct: chase, max: cfg.maxChasePct }); continue; }

      const reason = `5-min candle closed ${inr(b.c)} ${dir === 1 ? 'above' : 'below'} the opening range ${dir === 1 ? 'high' : 'low'} (${inr(leg.trigger)}); ${dir === 1 ? 'above' : 'below'} VWAP ${inr(vw)}; volume ${volRatio.toFixed(1)}x average; Nifty ${idxState}.${plan.news ? ` News check: ${plan.news.verdict.replace('_', ' ')}, ${plan.news.reason}` : ''}`;
      const ctx = { checks, decidedAt: endT, newsAppliedAt: (S.watch.news || {}).at || null, planBuiltAt: plan.builtAt || null, planPromotedAt: plan.promotedAt || null, setupScore, stockChgPct: stockChg, niftyChgPct: niftyChg, relStrengthPct: relStrength, prevDayBreak, niftyAgrees,
        rulesUsed: this.configSnapshot(),
        conditionsPassed: ['closed beyond opening range', 'right side of VWAP', 'volume >= min', cfg.useIndexFilter ? 'Nifty agrees' : 'Nifty filter off', 'not chasing'],
        signalCandleTime: b.t, signalClose: b.c, signalVolume: b.v, avgVolume: avgVol, volRatio, rvolSlot, rvolCum, gapPct: plan.gapPct, vwap: vw, vwapDistPct: ((b.c - vw) / vw) * 100, niftyState: idxState, chasePct: chase, trigger: leg.trigger, minuteOfDay: minOfDay(b.t) };
      this.enter(plan, leg, side, ref, isLatest ? lastT + 60000 : endT, reason, ctx);
      if (sigRec && leg.status !== 'entered') { sigRec.final = 'REJECTED'; sigRec.failed = ['position sizing: ' + (leg.note || 'not enough capital')]; }
      return;
    }
    if (Object.values(plan.legs).every(l => l.status !== 'waiting') && plan.status === 'waiting') {
      plan.status = 'skipped'; plan.note = 'No valid entry today.';
    }
  }

  // Live preview of the four entry conditions per stock, using the latest price (not waiting
  // for the 5-min candle to close). The real entry in evaluate() only fires on a closed candle,
  // so this is "what it's watching right now", not a guarantee the next closed candle matches.
  liveView() {
    const S = this.S, cfg = this.cfg;
    const idxC = S.candles[cfg.indexSymbol] || [];
    const idxLtp = idxC.length ? idxC[idxC.length - 1].c : null;
    const idxVw = idxC.length ? vwap(idxC) : null;
    const idxState = (idxLtp != null && idxVw != null) ? (idxLtp > idxVw ? 'up' : 'down') : 'unknown';
    const stocks = [];
    for (const plan of Object.values(S.plans)) {
      const c1 = S.candles[plan.sym] || [];
      if (!c1.length) { stocks.push({ sym: plan.sym, status: plan.status }); continue; }
      const ltp = c1[c1.length - 1].c;
      const vw = vwap(c1);
      const bars = aggregate(c1, 5);
      const curBar = bars[bars.length - 1];
      const volRatio = curBar ? volumeRatio(bars) : null; // same helper as the entry decision (current candle included)
      const legs = {};
      for (const side of ['long', 'short']) {
        const leg = plan.legs[side];
        if (!leg) continue;
        const dir = side === 'long' ? 1 : -1;
        const breakout = dir === 1 ? ltp > leg.trigger : ltp < leg.trigger;
        const vwapSide = dir === 1 ? ltp > vw : ltp < vw;
        const volumeOk = volRatio == null ? null : volRatio >= cfg.minVolRatio;
        const indexAgree = !cfg.useIndexFilter || idxState === 'unknown' ? null : idxState === (dir === 1 ? 'up' : 'down');
        const chasePct = leg.trigger ? (Math.abs(ltp - leg.trigger) / leg.trigger) * 100 : 0;
        const notChasing = !breakout || chasePct <= cfg.maxChasePct;
        const checks = buildChecks({ side, leg, cfg, price: ltp, vwap: vw, volRatio, idxState, chasePct, deadWhy: leg.status === 'waiting' ? null : (leg.note || leg.status), positions: S.positions.length, trades: S.tradesToday, maxPositions: S.risk.maxPositions, mod: minOfDay(S.now), live: true });
        legs[side] = { status: leg.status, trigger: leg.trigger, sl: leg.sl, tp: leg.tp, qty: leg.qty, volRatio, chasePct, conditions: { breakout, vwapSide, volumeOk, indexAgree, notChasing }, checks };
      }
      stocks.push({ sym: plan.sym, status: plan.status, ltp, vwap: vw, legs });
    }
    return { idxState, idxLtp, idxVwap: idxVw, stocks };
  }

  enter(plan, leg, side, ref, startT, reason, ctx) {
    const S = this.S, cfg = this.cfg;
    const dir = side === 'long' ? 1 : -1;
    const fill = r05(ref * (1 + (dir * cfg.slippagePct) / 100));
    const dist = Math.abs(fill - leg.sl);
    if (dist < fill * 0.002) { leg.status = 'skipped'; leg.note = 'Stop too tight at entry price.'; return; }
    const eq = this.equity();
    const used = S.positions.reduce((a, p) => a + p.qty * p.entry, 0);
    const free = Math.max(0, eq * cfg.leverage - used);
    const qty = Math.floor(Math.min((eq * cfg.riskPct * S.risk.mult) / 100 / dist, (eq * cfg.leverage * cfg.maxAllocPct) / 100 / fill, free / fill));
    if (qty < 1) { leg.status = 'skipped'; leg.note = 'Not enough buying power for one share.'; return; }
    if (qty * dist < ((eq * cfg.riskPct * S.risk.mult) / 100) * 0.25) { leg.status = 'skipped'; leg.note = 'Not enough free capital for a meaningful position size.'; return; }
    const tp = r05(fill + dir * cfg.rr * dist);
    const fee = charges(dir === 1 ? 'BUY' : 'SELL', qty * fill);
    S.realized -= fee;
    const info = S.watch.picked.find(p => p.sym === plan.sym) || null;
    const news = S.watch.news || {};
    const full = { ...ctx, fill, slippagePct: cfg.slippagePct, planBias: plan.bias, fromBackup: !!plan.fromBackup, replacedSlot: plan.replacedSlot || null, or: plan.or, gapPct: plan.gapPct, stock: info, shortlistRank: info ? S.watch.picked.indexOf(info) + 1 : null, equityAtEntry: eq, openPositionsBefore: S.positions.length, tradesTodayBefore: S.tradesToday, riskMult: S.risk.mult, vix: S.risk.vix, newsRisk: S.risk.newsRisk, newsVerdict: news.verdicts ? news.verdicts[plan.sym] : null, legStopPlanned: leg.sl, legTargetPlanned: leg.tp, qtyPlannedAtBuild: leg.qty };
    const pos = { id: ++S.seq, sym: plan.sym, side, qty, entry: fill, sl: leg.sl, sl0: leg.sl, tp, R: dist, t: startT, best: fill, hi: fill, lo: fill, checkedTo: startT, trailing: false, fee, reason, ctx: full };
    S.positions.push(pos);
    S.tradesToday++;
    plan.status = 'entered';
    leg.status = 'entered';
    for (const l of Object.values(plan.legs)) if (l !== leg && l.status === 'waiting') { l.status = 'cancelled'; l.note = 'Other direction was taken.'; }
    this.log(side === 'long' ? 'buy' : 'sell', `${side === 'long' ? 'BUY' : 'SELL SHORT'} ${qty} ${plan.sym} at ${inr(fill)}. Stop ${inr(leg.sl)}, target ${inr(tp)}, risk ${inr(qty * dist)}. Why: ${reason}`);
  }

  // ---------------- exits ----------------
  checkCandle(pos, k) {
    const slip = this.cfg.slippagePct / 100;
    const long = pos.side === 'long';
    const stopName = pos.trailing ? 'Trailing stop' : 'Stop loss';
    if (long) {
      if (k.o <= pos.sl) return { price: k.o * (1 - slip), reason: stopName + ' (gap)' };
      if (k.l <= pos.sl) return { price: pos.sl * (1 - slip), reason: stopName };
      if (k.o >= pos.tp) return { price: k.o, reason: 'Target hit (gap)' };
      if (k.h >= pos.tp) return { price: pos.tp, reason: 'Target hit' };
    } else {
      if (k.o >= pos.sl) return { price: k.o * (1 + slip), reason: stopName + ' (gap)' };
      if (k.h >= pos.sl) return { price: pos.sl * (1 + slip), reason: stopName };
      if (k.o <= pos.tp) return { price: k.o, reason: 'Target hit (gap)' };
      if (k.l <= pos.tp) return { price: pos.tp, reason: 'Target hit' };
    }
    return null;
  }

  trail(pos, k) {
    if (!this.cfg.trailing) return;
    const dir = pos.side === 'long' ? 1 : -1;
    pos.best = dir === 1 ? Math.max(pos.best, k.h) : Math.min(pos.best, k.l);
    const gainR = ((pos.best - pos.entry) * dir) / pos.R;
    let ns = pos.sl;
    if (gainR >= this.cfg.breakevenR) ns = dir === 1 ? Math.max(ns, pos.entry) : Math.min(ns, pos.entry);
    if (gainR >= 1.5) ns = dir === 1 ? Math.max(ns, pos.best - pos.R) : Math.min(ns, pos.best + pos.R);
    ns = r05(ns);
    if (dir === 1 ? ns > pos.sl : ns < pos.sl) {
      if (!pos.trailing) this.log('info', `${pos.sym}: up 1R, stop moved to breakeven ${inr(ns)}.`);
      pos.sl = ns; pos.trailing = true;
    }
  }

  managePositions(now) {
    const S = this.S, cfg = this.cfg;
    const limitT = atMinute(S.day, cfg.squareOffMin);
    const forming = cfg.mode === 'live';
    for (const pos of S.positions.slice()) {
      const c1 = S.candles[pos.sym];
      if (!c1 || !c1.length) continue;
      const lastT = c1[c1.length - 1].t;
      for (const k of c1) {
        if (k.t < pos.checkedTo) continue;
        if (k.t >= limitT) break;
        pos.hi = Math.max(pos.hi == null ? pos.entry : pos.hi, k.h); pos.lo = Math.min(pos.lo == null ? pos.entry : pos.lo, k.l);
        const hit = this.checkCandle(pos, k);
        if (hit) { this.closePos(pos, r05(hit.price), hit.reason, k.t + 60000); break; }
        if (!forming || k.t < lastT) { this.trail(pos, k); pos.checkedTo = k.t + 60000; }
      }
    }
  }

  squareOff(sqT, reason) {
    const S = this.S, slip = this.cfg.slippagePct / 100;
    for (const pos of S.positions.slice()) {
      const c1 = S.candles[pos.sym] || [];
      const k = c1.find(x => x.t >= sqT);
      const base = k ? k.o : this.lastPrice(pos.sym) || pos.entry;
      const price = r05(base * (1 + (pos.side === 'long' ? -slip : slip)));
      this.closePos(pos, price, reason, sqT);
    }
  }

  closeAll(reason, tMs) {
    const slip = this.cfg.slippagePct / 100;
    for (const pos of this.S.positions.slice()) {
      const lp = this.lastPrice(pos.sym) || pos.entry;
      this.closePos(pos, r05(lp * (1 + (pos.side === 'long' ? -slip : slip))), reason, tMs);
    }
  }

  closePos(pos, price, reason, tMs) {
    const S = this.S;
    const dir = pos.side === 'long' ? 1 : -1;
    const gross = (price - pos.entry) * dir * pos.qty;
    const fee = charges(dir === 1 ? 'SELL' : 'BUY', pos.qty * price);
    S.realized += gross - fee;
    const net = gross - fee - pos.fee;
    S.closed.unshift({ entryChecks: pos.ctx && pos.ctx.checks ? pos.ctx.checks : null, entryCtx: pos.ctx ? { or: pos.ctx.or, gapPct: pos.ctx.gapPct, planBias: pos.ctx.planBias, stockWhy: pos.ctx.stock ? pos.ctx.stock.why : null, newsVerdict: pos.ctx.newsVerdict, vix: pos.ctx.vix, riskMult: pos.ctx.riskMult, shortlistRank: pos.ctx.shortlistRank, setupScore: pos.ctx.setupScore, volRatio: pos.ctx.volRatio, vwapDistPct: pos.ctx.vwapDistPct, relStrengthPct: pos.ctx.relStrengthPct, fromBackup: pos.ctx.fromBackup, decidedAt: pos.ctx.decidedAt } : null, score: pos.ctx && pos.ctx.setupScore ? pos.ctx.setupScore.score : null, grade: pos.ctx && pos.ctx.setupScore ? pos.ctx.setupScore.grade : null, sym: pos.sym, side: pos.side, qty: pos.qty, entry: pos.entry, exit: price, net, gross, fees: pos.fee + fee, reason, tIn: pos.t, tOut: tMs, r: net / (pos.R * pos.qty), sl0: pos.sl0, tp: pos.tp, why: pos.reason, moved: pos.trailing });
    if (S.closed.length > 300) S.closed.pop();
    if (S.closed[60]) { delete S.closed[60].entryChecks; delete S.closed[60].entryCtx; }
    S.positions = S.positions.filter(p => p !== pos);
    if (S.plans[pos.sym]) S.plans[pos.sym].status = 'done';
    const hi = pos.hi == null ? pos.entry : Math.max(pos.hi, price), lo = pos.lo == null ? pos.entry : Math.min(pos.lo, price);
    this.queue('trades', {
      day: dayKey(pos.t), id: pos.id, sym: pos.sym, side: pos.side, qty: pos.qty, tIn: pos.t, tOut: tMs, minutesHeld: Math.round((tMs - pos.t) / 60000),
      entry: pos.entry, exit: price, stopInitial: pos.sl0, stopFinal: pos.sl, target: pos.tp, riskPerShare: pos.R, riskAmount: pos.R * pos.qty, invested: pos.qty * pos.entry,
      gross, fees: pos.fee + fee, net, rMultiple: net / (pos.R * pos.qty), outcome: net > 0 ? 'win' : 'loss', exitReason: reason, stopMoved: pos.trailing,
      mfeR: (dir === 1 ? hi - pos.entry : pos.entry - lo) / pos.R, maeR: (dir === 1 ? pos.entry - lo : hi - pos.entry) / pos.R,
      entryReason: pos.reason, ctx: pos.ctx || null, equityAfter: this.equity(), strategyVersion: this.cfg.strategyVersion
    });
    this.log(net >= 0 ? 'win' : 'loss', `Closed ${pos.side} ${pos.qty} ${pos.sym} at ${inr(price)}. ${reason}. Net ${net >= 0 ? '+' : '-'}${inr(Math.abs(net))} after charges.`);
  }

  // ---------------- what the dashboard sees ----------------
  snapshot() {
    const S = this.S, cfg = this.cfg;
    const eq = this.equity();
    const idxC = S.candles[cfg.indexSymbol] || [];
    let index = null;
    if (idxC.length) {
      const last = idxC[idxC.length - 1].c, v = vwap(idxC);
      index = { last, vwap: v, state: last > v ? 'up' : 'down', chg: (last / idxC[0].o - 1) * 100 };
    }
    return {
      mode: cfg.mode, day: S.day, now: S.now, phase: S.phase, paused: this.clock.paused, speed: this.clock.speed,
      finished: this.clock.finished(), error: S.error, cap: cfg.capital, equity: eq, realized: S.realized,
      dayPnl: eq - S.dayStartEquity, halted: S.halted, tradesToday: S.tradesToday,
      config: { riskPct: cfg.riskPct, rr: cfg.rr, maxPositions: cfg.maxPositions, dailyLossPct: cfg.dailyLossPct, leverage: cfg.leverage, squareOffMin: cfg.squareOffMin, lastEntryMin: cfg.lastEntryMin, allowShort: cfg.allowShort, newsGuard: cfg.newsGuard, newsRequired: cfg.newsRequired },
      watch: S.watch ? { picked: S.watch.picked, rejected: S.watch.rejected.slice(0, 12), analyzed: S.watch.analyzed, failed: S.watch.failed.length, index: S.watch.index, news: S.watch.news, backupsLeft: S.watch.backups.length } : null,
      pendingReplacements: Object.entries(S.pendingReplacements).map(([slot, p]) => ({ slot, candidates: p.candidates.map(c => c.sym) })),
      pendingPrompt: this.pendingPrompt(),
      risk: S.risk,
      rules: this.configSnapshot(),
      index,
      live: S.planBuilt ? this.liveView() : null,
      plans: Object.values(S.plans),
      positions: S.positions.map(p => {
        const ltp = this.lastPrice(p.sym) || p.entry, dir = p.side === 'long' ? 1 : -1;
        return { ...p, ltp, pnl: (ltp - p.entry) * dir * p.qty, pct: ((ltp / p.entry - 1) * 100) * dir };
      }),
      closed: S.closed.slice(0, 60),
      events: S.events.slice(0, 80),
      curve: S.curve,
      stats: tradeStats(S.closed)
    };
  }
}

module.exports = { Engine, charges };
