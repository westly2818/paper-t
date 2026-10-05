// Mover scanner: a STUDY, not a strategy. It never trades and never touches the opening-range engine or the swing portfolio.
// Each trading morning, after 09:35, it lists Nifty 200 stocks that are 2% or more away from yesterday's close (gap-ups, gap-downs,
// early jumps) with their early volume, asks whether there is a real company-specific reason in news published BEFORE 09:35,
// and stores the list forever. After the close it records what each one did next. movers-report / the Movers tab then answer:
// "do big opening moves with a real reason keep going, by more than charges (about 0.14% round trip)?"
// Own storage keys (paper-trader:movers:*), own timer. Errors are caught here.
const { yf, NAMES } = require('./data');
const { dayKey, minOfDay, isWeekday } = require('./time');
const { classifyMovers } = require('./catalyst');
const { Store } = require('./store');

const OPEN = 555, K_REF = 3, K_1030 = 14, K_1200 = 39, K_1330 = 51, K_1515 = 72; // bar index = (minute of day - 555) / 5
const COST_PCT = 0.14, MOVE_PCT = 2, STRONG_RVOL = 1.5, MAX_CLASSIFY = 50;
const SCAN_FROM = 9 * 60 + 38, SCAN_UNTIL = 10 * 60 + 25, OUTCOME_FROM = 15 * 60 + 45;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
const tstat = a => (a.length > 3 && sd(a) > 0 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : null);

// ---------------- pure rules (shared with movers-backfill.js and the tests) ----------------
function sessionsOf(bars) {
  const m = new Map();
  for (const b of bars) {
    const k = (minOfDay(b.t) - OPEN) / 5;
    if (!Number.isInteger(k) || k < 0 || k > 74) continue;
    const d = dayKey(b.t);
    let a = m.get(d); if (!a) { a = new Array(75); m.set(d, a); }
    a[k] = b;
  }
  return m;
}

// What the stock had done by 09:35 (the close of the 09:30 bar), judged against yesterday's close and its own usual early volume.
function moverFeatures(sess, day) {
  const today = sess.get(day);
  if (!today || !today[0] || !today[1] || !today[2] || !today[3]) return null;
  const days = [...sess.keys()].filter(d => d < day).sort();
  if (!days.length) return null;
  const prev = sess.get(days[days.length - 1]);
  let prevClose = null; for (let k = 74; k >= 0; k--) if (prev[k]) { prevClose = prev[k].c; break; }
  const early = a => (a && a[0] && a[1] && a[2] && a[3] ? a[0].v + a[1].v + a[2].v + a[3].v : null);
  const recent = days.slice(-20);
  const base = recent.map(d => early(sess.get(d))).filter(x => x != null && x > 0);
  if (!prevClose || base.length < 10) return null;
  const totals = recent.map(d => sess.get(d).reduce((a, b) => a + (b ? b.v : 0), 0));
  const ev = today[0].v + today[1].v + today[2].v + today[3].v, ref = today[3].c;
  return { prevClose, open: today[0].o, ref, gapPct: (today[0].o / prevClose - 1) * 100, movePct: (ref / prevClose - 1) * 100, earlyVol: ev, rvol: ev / mean(base), turnover: mean(totals) * prevClose };
}

// The index has no volume, so it gets its own small helper: its move at 09:35 against yesterday's close.
function indexMove(sess, day) {
  const today = sess && sess.get(day);
  if (!today || !today[0] || !today[3]) return null;
  const days = [...sess.keys()].filter(d => d < day).sort(), prev = days.length ? sess.get(days[days.length - 1]) : null;
  let prevClose = null; if (prev) for (let k = 74; k >= 0; k--) if (prev[k]) { prevClose = prev[k].c; break; }
  return prevClose ? { movePct: (today[3].c / prevClose - 1) * 100, gapPct: (today[0].o / prevClose - 1) * 100 } : null;
}

// features: [{ sym, f }] -> movers sorted by size of the move
function selectMovers(list, { movePct = MOVE_PCT, strongRvol = STRONG_RVOL, minTurnover = 3e8 } = {}) {
  return list.filter(x => x.f && Math.abs(x.f.movePct) >= movePct && x.f.turnover >= minTurnover)
    .map(x => ({ sym: x.sym, dir: x.f.movePct >= 0 ? 1 : -1, movePct: x.f.movePct, gapPct: x.f.gapPct, rvol: x.f.rvol, strongVolume: x.f.rvol >= strongRvol, prevClose: x.f.prevClose, ref: x.f.ref }))
    .sort((a, b) => Math.abs(b.movePct) - Math.abs(a.movePct));
}

// What happened after 09:35, in the mover's own direction (+ means it kept going), raw and minus Nifty over the same interval.
function outcomeOf(today, nifty, dir) {
  if (!today || !today[K_REF]) return null;
  const ref = today[K_REF].c, nref = nifty && nifty[K_REF] ? nifty[K_REF].c : null;
  const px = (a, k, f = 'c') => (a && a[k] ? a[k][f] : null);
  let lastK = 74; while (lastK > 0 && !today[lastK]) lastK--;
  let nLast = 74; while (nifty && nLast > 0 && !nifty[nLast]) nLast--;
  const pts = { r1030: [px(today, K_1030), px(nifty, K_1030)], r1200: [px(today, K_1200), px(nifty, K_1200)], r1330: [px(today, K_1330), px(nifty, K_1330)], r1515: [px(today, K_1515, 'o'), px(nifty, K_1515, 'o')], rClose: [today[lastK].c, nifty && nifty[nLast] ? nifty[nLast].c : null] };
  const ret = {}, adj = {};
  for (const [k, [p, np]] of Object.entries(pts)) {
    ret[k] = p == null ? null : dir * (p / ref - 1) * 100;
    adj[k] = p == null || np == null || !nref ? null : ret[k] - dir * (np / nref - 1) * 100;
  }
  let hi = -Infinity, lo = Infinity;
  for (let k = K_REF + 1; k < K_1515; k++) if (today[k]) { hi = Math.max(hi, today[k].h); lo = Math.min(lo, today[k].l); }
  return { ref, ret, adj, mfe: hi > -Infinity ? (dir === 1 ? (hi / ref - 1) * 100 : (1 - lo / ref) * 100) : null, mae: lo < Infinity ? (dir === 1 ? (lo / ref - 1) * 100 : (1 - hi / ref) * 100) : null };
}

// scans: [{ day, sym, dir, movePct, gapPct, rvol, strongVolume, catalyst }]  outcomes: [{ day, sym, ret, adj, mfe, mae }]
function summarize(scans, outcomes) {
  const out = new Map(outcomes.map(o => [o.day + '|' + o.sym, o]));
  const rows = scans.map(s => ({ ...s, o: out.get(s.day + '|' + s.sym) })).filter(r => r.o && r.o.ret && r.o.ret.r1515 != null);
  const catOf = r => (r.catalyst && r.catalyst.verified && r.catalyst.explainsMove === true ? r.catalyst.category : null);
  const groups = [
    ['All movers (2% or more at 09:35)', () => true],
    ['Strong early volume (1.5x or more)', r => r.strongVolume],
    ['Weaker early volume', r => !r.strongVolume],
    ['News explains the move', r => r.catalyst && r.catalyst.explainsMove === true],
    ['No news reason found', r => r.catalyst && r.catalyst.explainsMove === false],
    ['News check unverified or not run', r => !r.catalyst || r.catalyst.explainsMove == null],
    ['Strong volume AND news explains it', r => r.strongVolume && r.catalyst && r.catalyst.explainsMove === true],
    ['Up-moves', r => r.dir === 1], ['Down-moves', r => r.dir === -1],
    ['Gap of 3% or more', r => Math.abs(r.gapPct) >= 3],
    // the one lead from the 484-session price-only backfill: very large opening moves (see README); live data decides
    ['Move of 5% or more at 09:35', r => Math.abs(r.movePct) >= 5],
    ['Move of 6% or more at 09:35', r => Math.abs(r.movePct) >= 6]
  ];
  const cats = {}; for (const r of rows) { const c = catOf(r); if (c) cats[c] = (cats[c] || 0) + 1; }
  for (const [c, n] of Object.entries(cats)) if (n >= 5) groups.push(['News category: ' + c.replace(/_/g, ' '), r => catOf(r) === c]);
  const stat = rs => {
    const byDay = {}; for (const r of rs) (byDay[r.day] = byDay[r.day] || []).push(r.o.ret.r1515);
    const dayMeans = Object.values(byDay).map(mean), g = k => mean(rs.map(r => r.o.ret[k]).filter(x => x != null)), ga = k => mean(rs.map(r => r.o.adj[k]).filter(x => x != null));
    return { n: rs.length, days: dayMeans.length, r1030: g('r1030'), r1200: g('r1200'), r1515: g('r1515'), adj1515: ga('r1515'), mfe: mean(rs.map(r => r.o.mfe).filter(x => x != null)), mae: mean(rs.map(r => r.o.mae).filter(x => x != null)), win: rs.filter(r => r.o.ret.r1515 > 0).length / rs.length * 100, t: tstat(dayMeans), net: g('r1515') - COST_PCT };
  };
  return { rows: rows.length, days: new Set(rows.map(r => r.day)).size, cost: COST_PCT, groups: groups.map(([name, f]) => { const rs = rows.filter(f); return rs.length ? { name, ...stat(rs) } : { name, n: 0 }; }) };
}

// ---------------- live data (replaceable in tests) ----------------
function liveData(cfg) {
  return {
    symbols: () => cfg.watchlist.slice(),
    bars5m: sym => yf(sym, '5m', '1mo', 3),
    async marketTraded(day) { return (await yf(cfg.indexSymbol, '5m', '1d', 2)).some(b => dayKey(b.t) === day); }
  };
}

class MoverScanner {
  constructor(cfg, opts = {}) {
    this.cfg = cfg; this.store = opts.store || new Store(cfg, 'movers'); this.data = opts.data || liveData(cfg);
    this.classify = opts.classify || classifyMovers; this.names = opts.names || NAMES;
    this.key = opts.key || (() => process.env.GEMINI_API_KEY || process.env.LLM_API_KEY_FREE || '');
    this.state = null; this.study = null; this.running = false; this.tradedCache = {}; this.studyAt = 0;
  }
  fresh() { return { v: 1, today: null, pending: [], events: [], outbox: [] }; }
  log(kind, text) { this.state.events.unshift({ t: Date.now(), kind, text }); if (this.state.events.length > 60) this.state.events.pop(); }
  async load() {
    try { this.state = (await this.store.get('state')) || this.fresh(); } catch (e) { console.error('Movers: load failed, starting fresh:', e.message); this.state = this.fresh(); }
    if (!this.state.outbox) this.state.outbox = [];
    console.log(`Mover scanner ready: last scan ${this.state.today ? this.state.today.day : 'never'}, ${this.state.pending.length} day(s) waiting for outcomes.`);
    this.refreshStudy().catch(() => {});
  }
  async save() {
    const st = this.state;
    while (st.outbox.length) { const o = st.outbox[0]; try { await this.store.push(o.name, o.rec); st.outbox.shift(); } catch (e) { console.error('Movers: log write failed, will retry:', e.message); break; } }
    try { await this.store.set('state', st); } catch (e) { console.error('Movers: state save failed:', e.message); }
  }
  async refreshStudy() {
    this.studyAt = Date.now();
    this.study = summarize(await this.store.list('scans'), await this.store.list('outcomes'));
  }
  async isTradingDay(day, mod) {
    if (this.tradedCache[day] !== undefined) return this.tradedCache[day];
    if (mod < 561) return false;
    let t = false; try { t = await this.data.marketTraded(day); } catch (e) { return false; }
    if (t || mod > 16 * 60) this.tradedCache[day] = t;
    return t;
  }

  async tick(now = Date.now()) {
    if (this.running || !this.state) return;
    this.running = true;
    try {
      const day = dayKey(now), mod = minOfDay(now), st = this.state;
      const pendingPast = st.pending.some(p => p.day < day);
      const needScan = isWeekday(now) && (!st.today || st.today.day !== day) && mod >= SCAN_FROM && mod <= SCAN_UNTIL;
      const needOutcome = st.pending.some(p => p.day === day) && mod >= OUTCOME_FROM;
      if (!needScan && !needOutcome && !pendingPast) return;
      if ((needScan || needOutcome) && !(await this.isTradingDay(day, mod))) return;
      if (needScan) await this.scan(day, now);
      if (pendingPast || needOutcome) await this.outcomes(day, now);
      if (Date.now() - this.studyAt > 10 * 60000) await this.refreshStudy().catch(() => {});
    } catch (e) {
      console.error('Movers error:', e.message);
      if (this.state) this.log('warn', 'Error: ' + e.message);
    } finally { this.running = false; }
  }

  async fetchAll(syms) {
    const out = {}; let i = 0;
    const worker = async () => { while (i < syms.length) { const s = syms[i++]; try { out[s] = sessionsOf(await this.data.bars5m(s)); } catch (e) { /* skipped */ } await sleep(60); } };
    await Promise.all([worker(), worker(), worker()]);
    return out;
  }

  async scan(day, now) {
    const st = this.state, syms = this.data.symbols();
    const all = await this.fetchAll([this.cfg.indexSymbol, ...syms]);
    const feats = syms.filter(s => all[s]).map(s => ({ sym: s, f: moverFeatures(all[s], day) }));
    const withFeatures = feats.filter(x => x.f).length;
    if (withFeatures < 0.8 * syms.length) { this.log('warn', `Scan attempt: only ${withFeatures} of ${syms.length} stocks have the 09:35 bar yet, trying again.`); return; }
    const nf = indexMove(all[this.cfg.indexSymbol], day);
    const movers = selectMovers(feats, { minTurnover: this.cfg.minTurnover });
    const top = movers.slice(0, MAX_CLASSIFY);
    let catalysts = {}, model = null, error = null;
    if (this.key() && top.length) {
      try {
        const names = Object.fromEntries(top.map(m => [m.sym, this.names.get(m.sym)]).filter(([, n]) => n));
        const r = await this.classify({ movers: top, names, nowMs: Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), 4, 5), key: this.key(), model: this.cfg.geminiModel });
        catalysts = r.byStock; model = r.model;
      } catch (e) { error = e.message; this.log('warn', 'News classification failed (' + e.message + '). The movers are still saved, marked unchecked.'); }
    } else if (!this.key()) error = 'No Gemini key: news not checked';
    const rec = movers.map(m => ({ day, sym: m.sym, name: this.names.get(m.sym) || null, dir: m.dir, movePct: m.movePct, gapPct: m.gapPct, rvol: m.rvol, strongVolume: m.strongVolume, prevClose: m.prevClose, ref: m.ref, niftyMovePct: nf ? nf.movePct : null, catalyst: catalysts[m.sym] || null }));
    st.today = { day, scannedAt: now, universe: syms.length, withFeatures, niftyMovePct: nf ? nf.movePct : null, movers: rec, model, error };
    for (const r of rec) st.outbox.push({ name: 'scans', rec: r });
    if (rec.length) st.pending.push({ day, movers: rec.map(r => ({ sym: r.sym, dir: r.dir })) });
    this.log('plan', `Scan for ${day}: ${rec.length} stocks 2% or more from yesterday's close (${rec.filter(r => r.strongVolume).length} with strong early volume, ${rec.filter(r => r.catalyst && r.catalyst.explainsMove).length} with a news reason).`);
    await this.save();
  }

  async outcomes(todayKey, now) {
    const st = this.state;
    const due = st.pending.filter(p => p.day < todayKey || (p.day === todayKey && minOfDay(now) >= OUTCOME_FROM));
    if (!due.length) return;
    const syms = [...new Set(due.flatMap(p => p.movers.map(m => m.sym)))];
    const all = await this.fetchAll([this.cfg.indexSymbol, ...syms]);
    const nifty = all[this.cfg.indexSymbol];
    for (const p of due) {
      const kept = [];
      for (const m of p.movers) {
        const sess = all[m.sym] && all[m.sym].get(p.day), o = outcomeOf(sess, nifty && nifty.get(p.day), m.dir);
        if (!o) { kept.push(m); continue; }
        st.outbox.push({ name: 'outcomes', rec: { day: p.day, sym: m.sym, dir: m.dir, ...o } });
        if (st.today && st.today.day === p.day) { st.today.outcomes = st.today.outcomes || {}; st.today.outcomes[m.sym] = { r1030: o.ret.r1030, r1200: o.ret.r1200, r1515: o.ret.r1515, adj1515: o.adj.r1515, mfe: o.mfe, mae: o.mae }; }
      }
      st.pending = st.pending.filter(x => x !== p);
      if (kept.length && p.day === todayKey) st.pending.push({ day: p.day, movers: kept });
      this.log('info', `Outcomes recorded for ${p.day}: ${p.movers.length - kept.length} of ${p.movers.length} stocks.`);
    }
    await this.save();
    await this.refreshStudy().catch(() => {});
  }

  snapshot() {
    const st = this.state;
    if (!st) return { enabled: true, loading: true };
    return { enabled: true, today: st.today, pending: st.pending.map(p => ({ day: p.day, n: p.movers.length })), study: this.study, events: st.events.slice(0, 20), cost: COST_PCT };
  }
}

module.exports = { MoverScanner, sessionsOf, moverFeatures, indexMove, selectMovers, outcomeOf, summarize, COST_PCT, MOVE_PCT, STRONG_RVOL };
