const { dayKey, minOfDay, atMinute, isWeekday, OPEN, CLOSE } = require('./time');
const { avg, vwap, aggregate } = require('./indicators');
const { analyzeDaily, pickStocks, buildTradePlan, r05 } = require('./planner');
const { tradeStats } = require('./stats');
const { runNewsGuard } = require('./news');

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
    this.reset();
  }

  reset() {
    this.S = {
      day: null, now: 0, phase: 'starting', realized: 0, positions: [], closed: [], events: [], curve: [],
      watch: null, plans: {}, candles: {}, planBuilt: false, halted: false, tradesToday: 0,
      dayStartEquity: this.cfg.capital, error: null, retryAt: 0, seq: 0,
      newsDone: false, newsTries: 0, risk: this.riskFrom(null, null)
    };
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
    S.day = day; S.watch = null; S.plans = {}; S.candles = {}; S.planBuilt = false;
    S.halted = false; S.tradesToday = 0; S.dayStartEquity = this.equity(); S.retryAt = 0;
    S.newsDone = false; S.newsTries = 0; S.risk = this.riskFrom(null, null);
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
    const poolSize = cfg.shortlistSize + (cfg.newsGuard ? 3 : 0);
    const { picked: pool, rejected } = pickStocks(infos, { ...cfg, shortlistSize: poolSize }, this.equity());
    let index = null;
    try { index = analyzeDaily(cfg.indexSymbol, await this.provider.daily(cfg.indexSymbol, day)); } catch (e) { /* optional */ }
    let vix = null;
    try { const vd = await this.provider.daily(cfg.vixSymbol, day); if (vd.length) vix = vd[vd.length - 1].c; } catch (e) { /* optional */ }
    S.risk = this.riskFrom(vix, null);
    S.watch = { day, pool, picked: pool.slice(0, cfg.shortlistSize), rejected, failed, analyzed: infos.length, index, news: { status: cfg.newsGuard ? 'pending' : 'off' } };
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

  async newsStep(mod) {
    const S = this.S, cfg = this.cfg;
    if (S.newsDone) return;
    if (cfg.mode === 'live' && mod < 8 * 60 + 30) { S.watch.news = { status: 'waiting', note: 'News check runs at 8:30 IST so it is fresh.' }; return; }
    try {
      const r = await runNewsGuard(S.watch.pool.map(p => p.sym), cfg, S.now);
      const rejected = S.watch.rejected.slice(), kept = [], avoided = [];
      for (const info of S.watch.pool) {
        const v = r.stocks[info.sym];
        info.news = v;
        info.allow = v.verdict === 'long_only' ? 'long' : v.verdict === 'short_only' ? 'short' : 'both';
        if (v.verdict === 'avoid') { rejected.unshift({ sym: info.sym, why: 'News: ' + v.reason }); avoided.push(info.sym); }
        else kept.push(info);
      }
      for (const info of kept.slice(cfg.shortlistSize)) rejected.push({ sym: info.sym, why: 'Ranked below the shortlist' });
      S.watch.picked = kept.slice(0, cfg.shortlistSize);
      S.watch.rejected = rejected;
      S.watch.news = { status: 'ok', model: r.model, market: r.market, sources: r.sources, at: S.now };
      S.risk = this.riskFrom(S.risk.vix, r.market.risk);
      S.newsDone = true;
      this.log('plan', `News check done (${r.model}). Market risk: ${r.market.risk}.${r.market.summary ? ' ' + r.market.summary : ''}${avoided.length ? ' Dropped for news: ' + avoided.join(', ') + '.' : ''} Shortlist: ${S.watch.picked.map(p => p.sym + (p.allow !== 'both' ? ` (${p.allow} only)` : '')).join(', ')}.`);
    } catch (e) {
      S.newsTries++;
      S.watch.news = { status: 'error', error: e.message, tries: S.newsTries };
      if (S.newsTries < 3 || cfg.newsRequired) { S.retryAt = Date.now() + cfg.newsRetryMs; return; }
      S.newsDone = true;
      this.log('warn', `News check failed ${S.newsTries} times, trading continues without it. ${e.message}`);
    }
  }

  buildPlans() {
    const S = this.S, cfg = this.cfg;
    const eq = this.equity();
    const effCfg = { ...cfg, riskPct: cfg.riskPct * S.risk.mult };
    for (const info of S.watch.picked) {
      const c1 = S.candles[info.sym] || [];
      const plan = buildTradePlan(info, c1, effCfg, eq)
        || { sym: info.sym, bias: info.bias, news: info.news || null, status: 'skipped', note: 'No opening-range data', or: null, gapPct: 0, legs: {}, lastConsidered: 0 };
      S.plans[info.sym] = plan;
      if (plan.status === 'waiting') {
        const txt = Object.values(plan.legs).filter(l => l.status === 'waiting')
          .map(l => `${l.side === 'long' ? 'buy above' : 'short below'} ${inr(l.trigger)} (stop ${inr(l.sl)}, target ${inr(l.tp)}, qty ${l.qty})`).join('; ');
        this.log('plan', `${info.sym}: ${txt}`);
      } else this.log('plan', `${info.sym}: skipped. ${plan.note}`);
    }
    S.planBuilt = true;
  }

  // ---------------- main loop step ----------------
  async poll() {
    if (this.busy) return;
    this.busy = true;
    try { await this._poll(); this.S.error = null; }
    catch (e) { this.S.error = e.message; }
    finally { this.busy = false; }
  }

  async _poll() {
    const S = this.S, cfg = this.cfg;
    const now = this.clock.now(), day = dayKey(now), mod = minOfDay(now);
    if (S.day !== day) this.newDay(day);
    S.now = now;
    if (S.retryAt && Date.now() < S.retryAt) return;
    if (!S.watch) await this.preMarket(day);
    await this.newsStep(mod);
    if (S.retryAt && Date.now() < S.retryAt) return;
    if (cfg.mode === 'live' && !isWeekday(now)) { S.phase = 'weekend'; return; }
    if (mod < OPEN) { S.phase = 'pre-market'; return; }
    if (!S.newsDone) { S.phase = 'waiting-news'; return; }

    const syms = [cfg.indexSymbol, ...S.watch.picked.map(p => p.sym)];
    const got = await Promise.all(syms.map(s => this.provider.intraday(s, day).then(c => [s, c]).catch(e => { S.error = e.message; return [s, S.candles[s] || []]; })));
    for (const [s, c] of got) S.candles[s] = c;
    if (!(S.candles[cfg.indexSymbol] || []).length) { S.phase = mod > OPEN + 10 ? 'no-data' : 'opening'; return; }

    if (mod >= OPEN + cfg.orMinutes && !S.planBuilt) this.buildPlans();
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

    if (mod >= CLOSE) S.phase = 'closed';
    else if (mod >= cfg.squareOffMin) S.phase = 'square-off';
    else if (S.halted) S.phase = 'halted';
    else if (mod < OPEN + cfg.orMinutes) S.phase = 'opening-range';
    else if (mod > cfg.lastEntryMin) S.phase = 'no-new-trades';
    else S.phase = 'trading';

    S.curve.push({ t: now, e: this.equity() });
    if (S.curve.length > 3000) S.curve = S.curve.filter((_, i) => i % 2 === 0);
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

  evaluate(ev) {
    const S = this.S, cfg = this.cfg;
    const { plan, c1, b, done, isLatest, lastT } = ev;
    const endT = b.t + 300000;
    const vw = vwap(c1.filter(k => k.t < endT));
    const avgVol = avg(done.map(x => x.v));
    const volRatio = avgVol > 0 ? b.v / avgVol : 1;
    const idx = (S.candles[cfg.indexSymbol] || []).filter(k => k.t < endT);
    const idxState = idx.length ? (idx[idx.length - 1].c > vwap(idx) ? 'up' : 'down') : 'unknown';

    for (const side of ['long', 'short']) {
      const leg = plan.legs[side];
      if (!leg || leg.status !== 'waiting') continue;
      const dir = side === 'long' ? 1 : -1;
      // setup already dead?
      if (dir === 1 ? b.l <= leg.sl && b.c < leg.trigger : b.h >= leg.sl && b.c > leg.trigger) { leg.status = 'expired'; leg.note = 'Price moved to the stop level before a breakout. Setup failed.'; continue; }
      if (dir === 1 ? b.h >= leg.tp : b.l <= leg.tp) { leg.status = 'expired'; leg.note = 'Price reached the target level without a valid entry. Missed.'; continue; }
      if (!(dir === 1 ? b.c > leg.trigger : b.c < leg.trigger)) continue;

      if (!(dir === 1 ? b.c > vw : b.c < vw)) { leg.note = 'Broke the level but on the wrong side of VWAP. Waiting.'; continue; }
      if (volRatio < cfg.minVolRatio) { leg.note = `Broke the level on weak volume (${volRatio.toFixed(2)}x average). Waiting.`; continue; }
      if (cfg.useIndexFilter && idxState !== 'unknown' && idxState !== (dir === 1 ? 'up' : 'down')) { leg.note = `Nifty is ${idxState} against a ${side} trade. Waiting.`; continue; }
      const ref = isLatest ? c1[c1.length - 1].c : b.c;
      const chase = (Math.abs(ref - leg.trigger) / leg.trigger) * 100;
      if (chase > cfg.maxChasePct) { leg.note = `Price already ${chase.toFixed(2)}% past the trigger. Not chasing.`; continue; }

      const reason = `5-min candle closed ${inr(b.c)} ${dir === 1 ? 'above' : 'below'} the opening range ${dir === 1 ? 'high' : 'low'} (${inr(leg.trigger)}); ${dir === 1 ? 'above' : 'below'} VWAP ${inr(vw)}; volume ${volRatio.toFixed(1)}x average; Nifty ${idxState}.${plan.news ? ` News check: ${plan.news.verdict.replace('_', ' ')}, ${plan.news.reason}` : ''}`;
      this.enter(plan, leg, side, ref, isLatest ? lastT + 60000 : endT, reason);
      return;
    }
    if (Object.values(plan.legs).every(l => l.status !== 'waiting') && plan.status === 'waiting') {
      plan.status = 'skipped'; plan.note = 'No valid entry today.';
    }
  }

  enter(plan, leg, side, ref, startT, reason) {
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
    const pos = { id: ++S.seq, sym: plan.sym, side, qty, entry: fill, sl: leg.sl, sl0: leg.sl, tp, R: dist, t: startT, best: fill, checkedTo: startT, trailing: false, fee, reason };
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
    if (gainR >= 1) ns = dir === 1 ? Math.max(ns, pos.entry) : Math.min(ns, pos.entry);
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
    S.closed.unshift({ sym: pos.sym, side: pos.side, qty: pos.qty, entry: pos.entry, exit: price, net, gross, fees: pos.fee + fee, reason, tIn: pos.t, tOut: tMs, r: net / (pos.R * pos.qty), sl0: pos.sl0, tp: pos.tp, why: pos.reason, moved: pos.trailing });
    if (S.closed.length > 300) S.closed.pop();
    S.positions = S.positions.filter(p => p !== pos);
    if (S.plans[pos.sym]) S.plans[pos.sym].status = 'done';
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
      config: { riskPct: cfg.riskPct, rr: cfg.rr, maxPositions: cfg.maxPositions, dailyLossPct: cfg.dailyLossPct, leverage: cfg.leverage, squareOffMin: cfg.squareOffMin, lastEntryMin: cfg.lastEntryMin, allowShort: cfg.allowShort },
      watch: S.watch ? { picked: S.watch.picked, rejected: S.watch.rejected.slice(0, 12), analyzed: S.watch.analyzed, failed: S.watch.failed.length, index: S.watch.index, news: S.watch.news } : null,
      risk: S.risk,
      index,
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
