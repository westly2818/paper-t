// Momentum Strategy V5 Engine
// Implements the score-based momentum strategy:
// - Pre-market ranking (0-100 pts) selects top 6 stocks
// - Live momentum scoring (0-100 pts) evaluated on 5-min bars from 9:15 onwards
// - Three time-window setups:
//     A. 09:30-10:30 Opening Momentum / Breakout
//     B. 10:30-13:30 Pullback Continuation
//     C. 13:30-14:45 Afternoon Consolidation Breakout
// - Threshold: liveScore >= 70
// - Target: 1.5R, structure-based stops clamped to 0.4% - 1.2%
// - Square off at 15:15
// - Separate storage (paper-trader:v5:*) and API endpoints

const { dayKey, minOfDay, isWeekday, OPEN, CLOSE } = require('./time');
const { ema, vwap, avg } = require('./indicators');
const { analyzeDaily } = require('./planner');
const { preMarketScore, rankPremarket, liveScore, clamp01 } = require('./v5-score');
const { Store } = require('./store');
const { yf, NAMES } = require('./data');

// Approximate Indian intraday (MIS) equity charges per order
function charges(side, value) {
  const brokerage = Math.min(20, value * 0.0003);
  const stt = side === 'SELL' ? value * 0.00025 : 0;
  const txn = value * 0.0000297;
  const sebi = value * 0.000001;
  const stamp = side === 'BUY' ? value * 0.00003 : 0;
  const gst = 0.18 * (brokerage + txn + sebi);
  return brokerage + stt + txn + sebi + stamp + gst;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

class V5Engine {
  constructor(cfg, opts = {}) {
    this.cfg = cfg;
    this.store = opts.store || new Store(cfg, 'v5');
    this.data = opts.data || null; // for custom/mock data in tests
    this.clock = opts.clock || null;
    this.running = false;
    this.lastSaveAt = 0;
    this.state = null;
    this.names = NAMES;
  }

  fresh(day = null) {
    return {
      day,
      phase: 'starting',
      capital: this.cfg.v5Capital || 50000,
      realized: 0,
      positions: [],
      closed: [],
      events: [],
      curve: [],
      tradesToday: 0,
      top6: [],
      premarketDone: false,
      scores: {},
      lastTickAt: 0,
      halted: false
    };
  }

  log(level, text, nowMs = Date.now()) {
    if (!this.state) return;
    const ev = { t: nowMs, level, text };
    this.state.events.unshift(ev);
    if (this.state.events.length > 200) this.state.events.pop();
    console.log(`[V5 ${new Date(nowMs).toLocaleTimeString('en-IN')}] ${text}`);
  }

  async load() {
    try {
      const saved = await this.store.get('state');
      if (saved && saved.day) {
        this.state = saved;
        if (this.cfg.v5Capital && (!this.state.positions || this.state.positions.length === 0)) {
          if (this.state.tradesToday === 0 || this.state.capital === 20000) {
            this.state.capital = this.cfg.v5Capital + (this.state.realized || 0);
          }
        }
        this.log('info', `Loaded V5 state for day ${saved.day} with ${saved.positions.length} open position(s)`);
      } else {
        this.state = this.fresh(dayKey(Date.now()));
      }
    } catch (e) {
      console.error('V5Engine load error:', e.message);
      this.state = this.fresh(dayKey(Date.now()));
    }
  }

  async save() {
    if (!this.state) return;
    try {
      await this.store.set('state', this.state);
      this.lastSaveAt = Date.now();
    } catch (e) {
      console.error('V5Engine save error:', e.message);
    }
  }

  now() {
    return this.clock ? this.clock.now() : Date.now();
  }

  // ---------------- Data fetching helpers ----------------
  async fetchBars5m(sym) {
    if (this.data && this.data.bars5m) return this.data.bars5m(sym);
    // Yahoo also returns the candle that is still forming (partial or zero volume, sometimes at an off-grid minute).
    // Signals and RVOL must use closed 5-minute candles only, as in the replay lab.
    const now = this.now();
    return (await yf(sym, '5m', '5d')).filter(b => b.t % 300000 === 0 && b.t + 300000 <= now);
  }

  async fetchDaily(sym) {
    if (this.data && this.data.daily) return this.data.daily(sym);
    return yf(sym, '1d', '6mo');
  }

  // ---------------- Daily Pre-market Selection ----------------
  async preMarket(day, nowMs) {
    const st = this.state;
    this.log('plan', `Running V5 pre-market scoring for ${day}...`, nowMs);
    const watchlist = this.cfg.watchlist || [];
    const indexSym = this.cfg.indexSymbol || '^NSEI';

    let niftyDaily = null;
    try {
      niftyDaily = await this.fetchDaily(indexSym);
    } catch (e) {
      this.log('warn', `Failed to fetch index daily data: ${e.message}`, nowMs);
    }

    const infos = [];
    const syms = watchlist.slice(0, 80); // analyze top liquid universe
    let idx = 0;
    const worker = async () => {
      while (idx < syms.length) {
        const s = syms[idx++];
        try {
          const d = await this.fetchDaily(s);
          if (d && d.length >= 25) {
            const info = analyzeDaily(s, d);
            if (info) {
              // Estimate pre-open gap if available, else 0
              info.gapPct = 0;
              infos.push(info);
            }
          }
        } catch (_) {}
        await sleep(30);
      }
    };
    await Promise.all([worker(), worker(), worker()]);

    if (!infos.length) {
      this.log('warn', 'Could not fetch daily data for any watchlist symbols', nowMs);
      return;
    }

    // Rank candidates using V5 preMarketScore
    const slots = this.cfg.v5Slots || 6;
    const { picked } = rankPremarket(infos, niftyDaily, slots);
    st.top6 = picked.map(p => ({
      sym: p.sym,
      name: this.names.get(p.sym) || p.sym,
      bias: p.bias,
      close: p.close,
      atrPct: p.atrPct,
      turnover: p.turnover,
      preScore: p.preScore,
      preParts: p.preParts
    }));

    st.premarketDone = true;
    this.log('plan', `V5 selected top ${st.top6.length} stocks: ${st.top6.map(s => `${s.sym} (${s.preScore})`).join(', ')}`, nowMs);
    await this.save();
  }

  // ---------------- Live Bar Processing & Indicators ----------------
  computeIntradayContext(barsToday, niftyBarsToday, prevClose, niftyPrevClose) {
    if (!barsToday || barsToday.length < 3) return null;
    const n = barsToday.length;
    const lastBar = barsToday[n - 1];
    const c = lastBar.c;

    // VWAP
    const vw = vwap(barsToday);

    // EMAs on 5m closes
    const closes = barsToday.map(b => b.c);
    const e9 = ema(closes, 9);
    const e21 = ema(closes, 21);

    // RVOL: last candle volume vs today's average candle volume
    const avgVol = avg(barsToday.map(b => b.v));
    const rvol = avgVol > 0 ? lastBar.v / avgVol : 1.0;

    // Stock return from previous close
    const chg = prevClose ? ((c / prevClose) - 1) * 100 : 0;

    // Nifty returns
    let nchg = 0, nIntraChg = 0;
    if (niftyBarsToday && niftyBarsToday.length) {
      const nLast = niftyBarsToday[niftyBarsToday.length - 1];
      if (niftyPrevClose) nchg = ((nLast.c / niftyPrevClose) - 1) * 100;
      if (niftyBarsToday[0]) nIntraChg = ((nLast.c / niftyBarsToday[0].o) - 1) * 100;
    }

    // Recent range position over last 12 bars (or available)
    const lookback = Math.min(12, n);
    const recentBars = barsToday.slice(n - lookback);
    let hi = -Infinity, lo = Infinity;
    for (const b of recentBars) {
      if (b.h > hi) hi = b.h;
      if (b.l < lo) lo = b.l;
    }
    const rangePos = (hi > lo) ? (c - lo) / (hi - lo) : 0.5;

    return {
      c,
      vw,
      e9,
      e21,
      rvol,
      chg,
      nchg,
      nIntraChg,
      rangePos,
      open: barsToday[0].o,
      bars: barsToday,
      k: n - 1 // 0-indexed closed bar count
    };
  }

  // ---------------- Setup Detection ----------------
  // Setup A: 09:30 - 10:30 (minute 570 - 630) Opening Momentum / Breakout
  checkSetupA(ctx, dir) {
    const { bars, c, vw, e9, e21, rvol } = ctx;
    // Opening Range: first 3 bars (09:15 - 09:30, indices 0, 1, 2)
    if (bars.length < 4) return null;
    const orBars = bars.slice(0, 3);
    const orHi = Math.max(...orBars.map(b => b.h));
    const orLo = Math.min(...orBars.map(b => b.l));
    const orMid = (orHi + orLo) / 2;

    const lastBar = bars[bars.length - 1];

    if (dir === 1) {
      // Long: close > OR high, price > VWAP, 5m trend bullish (e9 > e21), RVOL >= 1.2
      if (c > orHi && c > vw && e9 > e21 && rvol >= 1.2) {
        // Stop: below breakout candle low or OR midpoint
        const rawStop = Math.min(lastBar.l, orMid);
        return { setup: 'A', dir: 1, rawStop, why: `OR Breakout above ${orHi.toFixed(1)}, VWAP ${vw.toFixed(1)}, RVOL ${rvol.toFixed(1)}x` };
      }
    } else if (dir === -1) {
      // Short: close < OR low, price < VWAP, 5m trend bearish (e9 < e21), RVOL >= 1.2
      if (c < orLo && c < vw && e9 < e21 && rvol >= 1.2) {
        const rawStop = Math.max(lastBar.h, orMid);
        return { setup: 'A', dir: -1, rawStop, why: `OR Breakdown below ${orLo.toFixed(1)}, VWAP ${vw.toFixed(1)}, RVOL ${rvol.toFixed(1)}x` };
      }
    }
    return null;
  }

  // Setup B: 10:30 - 13:30 (minute 630 - 810) Pullback Continuation
  checkSetupB(ctx, dir) {
    const { bars, c, vw, e9, e21, open } = ctx;
    const k = bars.length - 1;
    if (k < 5) return null;

    const ext = ((c / open) - 1) * 100;
    // Need stock already extended 1%+ from open in the trade direction
    if (dir * ext < 1.0) return null;
    // Must be on the right side of VWAP and 9/21 trend
    if (dir * (c - vw) <= 0 || dir * (e9 - e21) <= 0) return null;

    const lastBar = bars[k];
    const prevBar = bars[k - 1];

    // Look at recent pullback (past 4 bars) vs prior impulse (prior 6 bars)
    let lo = Infinity, hi = -Infinity, pullVol = 0, impVol = 0, n1 = 0, n2 = 0;
    for (let j = Math.max(0, k - 4); j < k; j++) {
      lo = Math.min(lo, bars[j].l);
      hi = Math.max(hi, bars[j].h);
      pullVol += bars[j].v;
      n1++;
    }
    for (let j = Math.max(0, k - 10); j < Math.max(0, k - 4); j++) {
      impVol += bars[j].v;
      n2++;
    }
    if (!n1 || !n2) return null;

    // Volume should be lighter during pullback
    const lighter = (pullVol / n1) < (impVol / n2);
    if (!lighter) return null;

    if (dir === 1) {
      // Pulled back to/near 9 EMA
      const touched = lo <= e9 * 1.002;
      // Reversal candle closes green and breaks previous bar's high
      const turn = c > lastBar.o && c > prevBar.h;
      if (touched && turn) {
        return { setup: 'B', dir: 1, rawStop: lo, why: `Pullback near 9 EMA (${lo.toFixed(1)}) with lighter volume and green reversal bar` };
      }
    } else if (dir === -1) {
      const touched = hi >= e9 * 0.998;
      const turn = c < lastBar.o && c < prevBar.l;
      if (touched && turn) {
        return { setup: 'B', dir: -1, rawStop: hi, why: `Pullback near 9 EMA (${hi.toFixed(1)}) with lighter volume and red reversal bar` };
      }
    }
    return null;
  }

  // Setup C: 13:30 - 14:45 (minute 810 - 885) Afternoon Consolidation Breakout
  checkSetupC(ctx, dir) {
    const { bars, c, vw, open } = ctx;
    const k = bars.length - 1;
    if (k < 10) return null;

    const ext = ((c / open) - 1) * 100;
    if (dir * ext < 1.0) return null;

    const lastBar = bars[k];

    // Past 10 bars consolidation
    let hi = -Infinity, lo = Infinity, vSum = 0, count = 0;
    for (let j = Math.max(0, k - 10); j < k; j++) {
      hi = Math.max(hi, bars[j].h);
      lo = Math.min(lo, bars[j].l);
      vSum += bars[j].v;
      count++;
    }
    if (count < 8) return null;

    // Consolidation range must be tight: under 0.8% of price
    const rangePct = ((hi - lo) / c) * 100;
    if (rangePct > 0.8) return null;

    // Volume expansion: breakout bar has >= 1.3x average volume of consolidation
    const avgConsolVol = vSum / count;
    if (avgConsolVol > 0 && lastBar.v < 1.3 * avgConsolVol) return null;

    if (dir === 1) {
      if (c > hi && c > vw) {
        return { setup: 'C', dir: 1, rawStop: lo, why: `Afternoon tight range (${rangePct.toFixed(2)}%) breakout with ${(lastBar.v / (avgConsolVol || 1)).toFixed(1)}x volume` };
      }
    } else if (dir === -1) {
      if (c < lo && c < vw) {
        return { setup: 'C', dir: -1, rawStop: hi, why: `Afternoon tight range (${rangePct.toFixed(2)}%) breakdown with ${(lastBar.v / (avgConsolVol || 1)).toFixed(1)}x volume` };
      }
    }
    return null;
  }

  // ---------------- Position Sizing & Entry ----------------
  enterTrade(sym, signal, ctx, scoreResult, nowMs) {
    const st = this.state;
    const maxTrades = this.cfg.v5MaxTrades || 6;
    const maxPos = this.cfg.v5MaxPositions || 3;
    const minScore = this.cfg.v5MinScore || 70;

    if (st.tradesToday >= maxTrades) return null;
    if (st.positions.length >= maxPos) return null;
    if (st.positions.some(p => p.sym === sym)) return null; // already open
    if (scoreResult.score < minScore) return null; // must meet score threshold

    const { dir, setup, rawStop, why } = signal;
    const entry = ctx.c;

    // Stop distance clamped between minStopPct (0.4%) and maxStopPct (1.2%)
    const minStopPct = this.cfg.minStopPct || 0.4;
    const maxStopPct = this.cfg.maxStopPct || 1.2;
    let stopPct = Math.abs(entry - rawStop) / entry * 100;
    if (dir === 1 ? rawStop >= entry : rawStop <= entry) stopPct = maxStopPct;
    stopPct = Math.max(minStopPct, Math.min(maxStopPct, stopPct));

    const stop = entry * (1 - dir * stopPct / 100);
    const rr = this.cfg.v5RR || 1.5;
    const target = entry * (1 + dir * rr * stopPct / 100);

    // Risk budget: default 1% of virtual capital
    const riskPct = this.cfg.riskPct || 1;
    const riskAmount = (st.capital || 50000) * (riskPct / 100);
    const stopDistance = Math.abs(entry - stop);
    let qty = Math.floor(riskAmount / stopDistance);

    // Max allocation cap (e.g. 50% of capital)
    const maxAllocPct = this.cfg.maxAllocPct || 50;
    const maxAlloc = (st.capital || 50000) * (maxAllocPct / 100);
    const maxQty = Math.floor(maxAlloc / entry);
    qty = Math.min(qty, maxQty);

    if (qty < 1) {
      this.log('info', `Skipped ${sym} trade: insufficient capital for 1 share`, nowMs);
      return null;
    }

    const value = qty * entry;
    const side = dir === 1 ? 'BUY' : 'SELL';
    const entryCharges = charges(side, value);

    const pos = {
      id: `${sym}-${Date.now()}`,
      sym,
      name: this.names.get(sym) || sym,
      side,
      dir,
      setup,
      entry,
      stop,
      target,
      qty,
      value,
      stopPct,
      score: scoreResult.score,
      parts: scoreResult.parts,
      entryCharges,
      openedAt: nowMs,
      why,
      highSince: entry,
      lowSince: entry
    };

    st.positions.push(pos);
    st.tradesToday++;
    this.log('trade', `ENTERED ${setup} ${side} ${qty}x ${sym} @ ${entry.toFixed(2)} | SL: ${stop.toFixed(2)} (${stopPct.toFixed(2)}%), TP: ${target.toFixed(2)} (1.5R) | Score: ${scoreResult.score}/100`, nowMs);

    return pos;
  }

  // ---------------- Position Management ----------------
  managePositions(prices, nowMs, isSquareOffTime = false) {
    const st = this.state;
    const openPos = [...st.positions];

    for (const pos of openPos) {
      const curPrice = prices[pos.sym];
      if (!curPrice) continue;

      pos.highSince = Math.max(pos.highSince || curPrice, curPrice);
      pos.lowSince = Math.min(pos.lowSince || curPrice, curPrice);

      let exitReason = null;
      let exitPrice = curPrice;

      if (pos.dir === 1) {
        if (curPrice <= pos.stop) {
          exitReason = 'stop';
          exitPrice = pos.stop;
        } else if (curPrice >= pos.target) {
          exitReason = 'target';
          exitPrice = pos.target;
        }
      } else if (pos.dir === -1) {
        if (curPrice >= pos.stop) {
          exitReason = 'stop';
          exitPrice = pos.stop;
        } else if (curPrice <= pos.target) {
          exitReason = 'target';
          exitPrice = pos.target;
        }
      }

      if (!exitReason && isSquareOffTime) {
        exitReason = 'time';
        exitPrice = curPrice;
      }

      if (exitReason) {
        this.closePos(pos, exitPrice, exitReason, nowMs);
      }
    }
  }

  closePos(pos, exitPrice, reason, nowMs) {
    const st = this.state;
    const exitSide = pos.dir === 1 ? 'SELL' : 'BUY';
    const exitValue = pos.qty * exitPrice;
    const exitCharges = charges(exitSide, exitValue);
    const totalCharges = pos.entryCharges + exitCharges;

    const grossPnL = pos.dir * (exitPrice - pos.entry) * pos.qty;
    const netPnL = grossPnL - totalCharges;
    const r = (pos.dir * (exitPrice - pos.entry) / (pos.entry * (pos.stopPct / 100)));

    const record = {
      id: pos.id,
      sym: pos.sym,
      name: pos.name,
      side: pos.side,
      dir: pos.dir,
      setup: pos.setup,
      entry: pos.entry,
      exit: exitPrice,
      stop: pos.stop,
      target: pos.target,
      qty: pos.qty,
      stopPct: pos.stopPct,
      score: pos.score,
      parts: pos.parts,
      grossPnL: Math.round(grossPnL * 100) / 100,
      netPnL: Math.round(netPnL * 100) / 100,
      charges: Math.round(totalCharges * 100) / 100,
      r: Math.round(r * 100) / 100,
      openedAt: pos.openedAt,
      closedAt: nowMs,
      exitReason: reason,
      why: pos.why
    };

    st.positions = st.positions.filter(p => p.id !== pos.id);
    st.closed.push(record);
    st.realized += netPnL;
    st.capital += netPnL;

    this.log('trade', `CLOSED ${pos.setup} ${pos.sym} @ ${exitPrice.toFixed(2)} (${reason}) | Net PnL: ₹${netPnL.toFixed(2)} (${r.toFixed(2)}R)`, nowMs);

    // Push trade record to store
    this.store.push('trades', record).catch(e => console.error('Failed to append trade to v5 store:', e.message));
  }

  // ---------------- Periodic Tick ----------------
  async tick(nowMs = this.now()) {
    if (this.running) return;
    this.running = true;

    try {
      const day = dayKey(nowMs);
      const mod = minOfDay(nowMs);

      if (!this.state) {
        await this.load();
      }

      const st = this.state;
      st.lastTickAt = nowMs;

      // Sync capital if config was updated and no trades/positions exist
      if (this.cfg.v5Capital && (!st.positions || st.positions.length === 0)) {
        if (st.tradesToday === 0 || st.capital === 20000) {
          if (st.capital !== this.cfg.v5Capital) {
            st.capital = this.cfg.v5Capital + (st.realized || 0);
            this.save().catch(() => {});
          }
        }
      }

      // Reset state on a new calendar day
      if (st.day !== day) {
        this.log('info', `New day ${day}: initializing V5 session`, nowMs);
        st.day = day;
        st.positions = [];
        st.tradesToday = 0;
        st.premarketDone = false;
        st.top6 = [];
        st.scores = {};
        st.realized = 0;
        await this.save();
      }

      // Check weekday
      if (!isWeekday(nowMs)) {
        st.phase = 'weekend';
        return;
      }

      // 1. Pre-market window: before 09:15
      if (mod < OPEN) {
        st.phase = 'premarket';
        if (!st.premarketDone) {
          await this.preMarket(day, nowMs);
        }
        return;
      }

      // Ensure pre-market ranking is ready even if started after 9:15
      if (!st.premarketDone || !st.top6.length) {
        await this.preMarket(day, nowMs);
      }

      const symbols = st.top6.map(s => s.sym);
      if (!symbols.length) {
        st.phase = 'idle';
        return;
      }

      // 2. Market hours: 09:15 - 15:30
      if (mod >= OPEN && mod <= CLOSE) {
        st.phase = mod >= 15 * 60 + 15 ? 'squareoff' : 'trading';

        // Fetch index and top 6 5m bars
        const indexSym = this.cfg.indexSymbol || '^NSEI';
        let niftyBars = [];
        try {
          niftyBars = await this.fetchBars5m(indexSym);
        } catch (_) {}
        const niftyToday = niftyBars.filter(b => dayKey(b.t) === day);

        const currentPrices = {};

        // Process each top 6 stock
        for (const sym of symbols) {
          try {
            const bars = await this.fetchBars5m(sym);
            const barsToday = bars.filter(b => dayKey(b.t) === day);
            if (!barsToday.length) continue;

            const lastBar = barsToday[barsToday.length - 1];
            currentPrices[sym] = lastBar.c;

            const sInfo = st.top6.find(s => s.sym === sym);
            const prevClose = sInfo ? sInfo.close : null;
            const niftyPrevClose = niftyBars.length > niftyToday.length ? niftyBars[niftyBars.length - niftyToday.length - 1]?.c : null;

            const ctx = this.computeIntradayContext(barsToday, niftyToday, prevClose, niftyPrevClose);
            if (!ctx) continue;

            // Compute live momentum score in both directions (long & short)
            const longScore = liveScore({ ...ctx, dir: 1 });
            const shortScore = liveScore({ ...ctx, dir: -1 });

            st.scores[sym] = {
              c: ctx.c,
              vw: ctx.vw,
              e9: ctx.e9,
              e21: ctx.e21,
              rvol: ctx.rvol,
              longScore: longScore.score,
              longParts: longScore.parts,
              shortScore: shortScore.score,
              shortParts: shortScore.parts,
              updatedAt: nowMs
            };

            // Entry checks: between 09:30 (570) and 14:45 (885)
            if (mod >= 9 * 60 + 30 && mod <= 14 * 60 + 45) {
              let signal = null;
              let bestScore = null;

              // Setup A: 09:30 - 10:30 (min 570 - 630)
              if (mod <= 10 * 60 + 30) {
                const sigLong = this.checkSetupA(ctx, 1);
                if (sigLong && longScore.score >= (this.cfg.v5MinScore || 70)) {
                  signal = sigLong;
                  bestScore = longScore;
                } else if (this.cfg.allowShort !== false) {
                  const sigShort = this.checkSetupA(ctx, -1);
                  if (sigShort && shortScore.score >= (this.cfg.v5MinScore || 70)) {
                    signal = sigShort;
                    bestScore = shortScore;
                  }
                }
              }

              // Setup B: 10:30 - 13:30 (min 630 - 810)
              if (!signal && mod > 10 * 60 + 30 && mod <= 13 * 60 + 30) {
                const sigLong = this.checkSetupB(ctx, 1);
                if (sigLong && longScore.score >= (this.cfg.v5MinScore || 70)) {
                  signal = sigLong;
                  bestScore = longScore;
                } else if (this.cfg.allowShort !== false) {
                  const sigShort = this.checkSetupB(ctx, -1);
                  if (sigShort && shortScore.score >= (this.cfg.v5MinScore || 70)) {
                    signal = sigShort;
                    bestScore = shortScore;
                  }
                }
              }

              // Setup C: 13:30 - 14:45 (min 810 - 885)
              if (!signal && mod > 13 * 60 + 30 && mod <= 14 * 60 + 45) {
                const sigLong = this.checkSetupC(ctx, 1);
                if (sigLong && longScore.score >= (this.cfg.v5MinScore || 70)) {
                  signal = sigLong;
                  bestScore = longScore;
                } else if (this.cfg.allowShort !== false) {
                  const sigShort = this.checkSetupC(ctx, -1);
                  if (sigShort && shortScore.score >= (this.cfg.v5MinScore || 70)) {
                    signal = sigShort;
                    bestScore = shortScore;
                  }
                }
              }

              if (signal && bestScore) {
                this.enterTrade(sym, signal, ctx, bestScore, nowMs);
              }
            }
          } catch (e) {
            // Log per-symbol errors without failing whole loop
          }
        }

        // Manage existing positions
        const isSquareOff = mod >= (this.cfg.squareOffMin || (15 * 60 + 15));
        this.managePositions(currentPrices, nowMs, isSquareOff);
      } else {
        st.phase = 'closed';
      }

      // Periodic state persistence (every 60s or on events)
      if (Date.now() - this.lastSaveAt > 60000) {
        await this.save();
      }
    } catch (e) {
      console.error('V5Engine tick error:', e.message);
    } finally {
      this.running = false;
    }
  }

  snapshot() {
    const st = this.state;
    if (!st) return { enabled: true, loading: true };
    return {
      enabled: true,
      day: st.day,
      phase: st.phase,
      capital: st.capital,
      realized: st.realized,
      tradesToday: st.tradesToday,
      openPositions: st.positions,
      closedTrades: st.closed.slice(-20),
      top6: st.top6,
      scores: st.scores,
      events: st.events.slice(0, 30),
      lastTickAt: st.lastTickAt
    };
  }
}

module.exports = {
  V5Engine,
  charges
};
