// F&O paper book: a weekly NIFTY iron condor (sell a call and a put about one standard deviation away, buy a call and a put further out as protection).
// PAPER ONLY, nothing is ever sent to a broker. It also saves a compact copy of the real option chain twice a day, so real option history builds up
// (Fyers has no history for expired contracts) and later tests can use real prices instead of modelled ones.
//
// Data: Fyers option chain (bid/ask/OI for every strike) and India VIX. Needs today's Fyers token: run  node --env-file=.env fyers-login.js  on your PC each
// morning; it also copies the token to the database, which is where this module reads it on Render. No token = the tab says so and nothing trades.
// Rules (from options-sim.js, fixed before going live; the history test of these rules is weak: see docs/STUDY-GUIDE.md):
//   enter   first trading day after the previous weekly expiry, from 10:00, when the nearest expiry is 4 to 8 days away
//   strikes shorts at spot +/- 1 standard deviation (VIX-implied move to expiry), rounded to 50; protection 1% of spot further out
//   fills   sell at the bid, buy at the ask (no mid-price flattery)
//   size    lots so that the worst case loss is at most fnoMaxRiskPct of capital; fewer than one lot = skip the week
//   stop    close when the loss reaches 1.5 x the credit received, checked every minute on the closing prices (buy shorts at the ask, sell protection at the bid)
//   exit    15:15 on expiry day, same closing prices
const { dayKey, minOfDay, hhmm, isWeekday } = require('./time');
const { Store } = require('./store');

const STEP = 50, STOP_X = 1.5;
const round50 = x => Math.round(x / STEP) * STEP;
const fmtExp = e => e;   // keep the exchange's own date text

// Brokerage Rs 20 per order, STT 0.15% on the premium of sold options, exchange charges 0.035% of premium on every leg, GST on those, 4 legs in and 4 out.
function charges(legs, orders) {
  const turnover = legs.reduce((a, l) => a + l.price * l.qty, 0), sold = legs.filter(l => l.sell).reduce((a, l) => a + l.price * l.qty, 0);
  const brokerage = 20 * orders, exch = 0.00035 * turnover, stt = 0.0015 * sold;
  return brokerage + exch + stt + 0.18 * (brokerage + exch);
}

// chain = { spot, vix, expiry: 'dd-mm-yyyy', rows: [{ strike, type: 'CE'|'PE', bid, ask, ltp, oi }] }
function planCondor(chain, calDays, lot, capital, maxRiskPct, wingPct = 1) {
  const { spot, vix, rows } = chain;
  if (!spot || !vix) return { ok: false, why: 'no spot or VIX' };
  const sigma = spot * (vix / 100) * Math.sqrt(calDays / 365);
  const find = (type, strike) => rows.find(r => r.type === type && r.strike === strike);
  const sc = round50(spot + sigma), sp = round50(spot - sigma), w = Math.max(STEP, round50(spot * wingPct / 100));
  const legs = [
    { type: 'CE', strike: sc, sell: true, row: find('CE', sc) }, { type: 'PE', strike: sp, sell: true, row: find('PE', sp) },
    { type: 'CE', strike: sc + w, sell: false, row: find('CE', sc + w) }, { type: 'PE', strike: sp - w, sell: false, row: find('PE', sp - w) }
  ];
  const missing = legs.filter(l => !l.row || !(l.sell ? l.row.bid > 0 : l.row.ask > 0));
  if (missing.length) return { ok: false, why: 'strikes without a live price: ' + missing.map(l => l.strike + l.type).join(', '), sigma };
  for (const l of legs) l.price = l.sell ? l.row.bid : l.row.ask;
  const credit = legs.reduce((a, l) => a + (l.sell ? l.price : -l.price), 0);
  if (credit <= 0) return { ok: false, why: 'no credit at these prices', sigma };
  const worstPerLot = (w - credit) * lot;
  const lots = Math.floor((capital * maxRiskPct / 100) / worstPerLot);
  if (lots < 1) return { ok: false, why: `one lot risks Rs ${Math.round(worstPerLot)}, more than ${maxRiskPct}% of capital`, sigma, credit, worstPerLot };
  return { ok: true, sigma, width: w, credit, lots, worstPerLot, legs: legs.map(l => ({ type: l.type, strike: l.strike, sell: l.sell, price: l.price })) };
}

// Cost to close now, per unit: buy shorts at the ask, sell protection at the bid.
function closeLegs(pos, rows) {
  const out = [];
  for (const l of pos.legs) {
    const r = rows.find(x => x.type === l.type && x.strike === l.strike);
    if (!r) return null;
    out.push({ price: l.sell ? (r.ask > 0 ? r.ask : r.ltp) : (r.bid > 0 ? r.bid : 0), buyBack: l.sell });
  }
  return out;
}
const costOf = legs => legs.reduce((a, l) => a + (l.buyBack ? l.price : -l.price), 0);
const closeCost = (pos, rows) => { const legs = closeLegs(pos, rows); return legs ? costOf(legs) : null; };
// After expiry the options settle at their value for the last spot seen.
function settleLegs(pos, spot) {
  return pos.legs.map(l => ({ price: Math.max(0, l.type === 'CE' ? spot - l.strike : l.strike - spot), buyBack: l.sell }));
}

class FnoBook {
  constructor(cfg, opts = {}) {
    this.cfg = cfg; this.store = opts.store || new Store(cfg, 'fno'); this.fyers = opts.fyers || new Store(cfg, 'fyers'); this.fetch = opts.fetch || fetch;
    this.state = null; this.token = null; this.tokenAt = 0; this.busy = false;
  }
  fresh() { return { capital: this.cfg.fnoCapital || 50000, pos: null, closed: [], events: [], snaps: 0, lastSnap: {}, status: { token: 'unknown' }, skippedWeeks: [] }; }
  async load() { this.state = (await this.store.get('state')) || this.fresh(); if (!this.state.capital) this.state.capital = this.cfg.fnoCapital || 50000; }
  async save() { if (this.state) await this.store.set('state', this.state); }
  log(text, now = Date.now()) { this.state.events.unshift({ t: now, text }); if (this.state.events.length > 60) this.state.events.length = 60; }

  async getToken(now) {
    if (this.token && now - this.tokenAt < 60000) return this.token;
    let t = null;
    try { t = await this.fyers.get('token'); } catch (_) { /* fall back to the local file */ }
    if (!t) { try { const f = require('path').join(__dirname, '..', 'data', 'fyers-token.json'); if (require('fs').existsSync(f)) t = JSON.parse(require('fs').readFileSync(f, 'utf8')); } catch (_) { /* none */ } }
    this.token = t; this.tokenAt = now; return t;
  }

  async chain(token, expiryEpoch) {
    const q = { symbol: 'NSE:NIFTY50-INDEX', strikecount: '25' }; if (expiryEpoch) q.timestamp = String(expiryEpoch);
    const r = await this.fetch('https://api-t1.fyers.in/data/options-chain-v3?' + new URLSearchParams(q), { headers: { Authorization: `${token.appId}:${token.access_token}` } });
    const j = await r.json();
    if (j.s !== 'ok' || !j.data) { const e = new Error(j.message || 'chain error'); e.code = j.code; throw e; }
    const d = j.data, idx = (d.optionsChain || []).find(x => x.strike_price === -1);
    const rows = (d.optionsChain || []).filter(x => x.option_type === 'CE' || x.option_type === 'PE').map(x => ({ strike: x.strike_price, type: x.option_type, bid: x.bid || 0, ask: x.ask || 0, ltp: x.ltp || 0, oi: x.oi || 0, vol: x.volume || 0 }));
    const v = d.indiavixData || {};
    return { spot: idx ? idx.ltp : null, vix: v.ltp != null ? v.ltp : v.fp != null ? v.fp : null, expiries: d.expiryData || [], rows };
  }

  nearestExpiry(expiries, now) {
    const today = dayKey(now);
    const list = expiries.map(e => { const [dd, mm, yy] = e.date.split('-').map(Number); const key = `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`; return { ...e, key, days: Math.round((Date.parse(key + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000) }; }).filter(e => e.days >= 0).sort((a, b) => a.days - b.days);
    return list;
  }

  async tick(now = Date.now()) {
    if (!this.state || this.busy) return;
    this.busy = true;
    try { await this._tick(now); } finally { this.busy = false; }
  }

  async _tick(now) {
    const st = this.state, day = dayKey(now), mod = minOfDay(now);
    if (!isWeekday(now) || mod < 9 * 60 + 20 || mod > 15 * 60 + 35) { st.status.phase = 'closed'; return; }
    const token = await this.getToken(now);
    if (!token) { st.status = { ...st.status, token: 'missing', phase: 'no-token', note: 'No Fyers token. Run fyers-login.js on your PC (it also sends the token here).' }; return; }
    let ch;
    try { ch = await this.chain(token); }
    catch (e) {
      const bad = /token|auth|expired/i.test(e.message) || e.code === -16 || e.code === -15;
      st.status = { ...st.status, token: bad ? 'expired' : 'ok', phase: 'data-error', note: bad ? 'Fyers token expired. Run fyers-login.js on your PC.' : 'Option data error: ' + e.message.slice(0, 80) };
      return;
    }
    const exps = this.nearestExpiry(ch.expiries, now);
    const near = exps[0];
    st.status = { token: 'ok', phase: 'live', spot: ch.spot, vix: ch.vix, expiry: near ? near.date : null, daysToExpiry: near ? near.days : null, updatedAt: now, note: '' };

    // twice a day: keep the real chain for later analysis
    for (const [tag, at] of [['open', 10 * 60], ['close', 15 * 60 + 15]]) {
      if (mod >= at && st.lastSnap[tag] !== day) {
        await this.store.push('chain', { day, tag, t: now, spot: ch.spot, vix: ch.vix, expiry: near && near.date, rows: ch.rows.map(r => [r.strike, r.type, r.bid, r.ask, r.ltp, r.oi]) });
        st.lastSnap[tag] = day; st.snaps++;
      }
    }

    if (st.pos) { await this.manage(token, st.pos, ch, near, now, mod); }
    else if (mod >= 10 * 60 && mod <= 14 * 60 && near && near.days >= 4 && near.days <= 8 && st.lastEntryDay !== day) {
      st.lastEntryDay = day;
      const plan = planCondor(ch, near.days, this.cfg.fnoLot || 65, st.capital, this.cfg.fnoMaxRiskPct || 25);
      if (!plan.ok) { this.log(`No condor this week: ${plan.why}.`, now); st.skippedWeeks.unshift({ day, expiry: near.date, why: plan.why }); st.skippedWeeks.length = Math.min(st.skippedWeeks.length, 20); }
      else {
        const lot = this.cfg.fnoLot || 65, qty = plan.lots * lot;
        const fee = charges(plan.legs.map(l => ({ price: l.price, qty, sell: l.sell })), 4);
        st.pos = { id: (st.closed.length || 0) + 1, day, t: now, expiry: near.date, expiryKey: near.key, qty, lots: plan.lots, lot, credit: plan.credit, width: plan.width, legs: plan.legs, fee, spotIn: ch.spot, vixIn: ch.vix, sigma: plan.sigma, worstLoss: plan.worstPerLot * plan.lots, stopLoss: STOP_X * plan.credit * qty, mtm: 0 };
        this.log(`SOLD condor ${near.date}: short ${plan.legs[0].strike}CE / ${plan.legs[1].strike}PE, protection ${plan.legs[2].strike}CE / ${plan.legs[3].strike}PE, ${plan.lots} lot(s), credit ${plan.credit.toFixed(1)} pts (Rs ${Math.round(plan.credit * qty)}), worst loss Rs ${Math.round(plan.worstPerLot * plan.lots)}.`, now);
      }
    }
    await this.save();
  }

  async manage(token, pos, ch, near, now, mod) {
    const st = this.state;
    let rows = ch.rows;
    if (near && near.date !== pos.expiry) {           // the position's own expiry is not the nearest any more (should not happen) or not yet: fetch it
      try { const full = await this.chain(token, (ch.expiries.find(e => e.date === pos.expiry) || {}).expiry); rows = full.rows; } catch (_) { return; }
    }
    const expiryDay = dayKey(now) === pos.expiryKey, past = dayKey(now) > pos.expiryKey;
    if (past) { this.close(pos, settleLegs(pos, pos.spot || ch.spot), 'Expired: settled at the last spot seen', now); return; }
    const legs = closeLegs(pos, rows);
    if (!legs) return;
    const cost = costOf(legs);
    pos.mtm = (pos.credit - cost) * pos.qty; pos.cost = cost; pos.spot = ch.spot; pos.updatedAt = now;
    let reason = null;
    if (pos.mtm <= -pos.stopLoss) reason = 'Stop: loss reached ' + STOP_X + 'x the credit';
    else if (expiryDay && mod >= 15 * 60 + 15) reason = 'Expiry day 15:15 exit';
    if (reason) this.close(pos, legs, reason, now);
  }

  close(pos, exitLegs, reason, now) {
    const st = this.state;
    const cost = costOf(exitLegs);
    const fee = pos.fee + charges(exitLegs.map(l => ({ price: l.price, qty: pos.qty, sell: !l.buyBack })), 4);
    const gross = (pos.credit - cost) * pos.qty;
    const rec = { ...pos, exitT: now, exitDay: dayKey(now), cost, gross, fees: fee, net: gross - fee, reason, r: (gross - fee) / pos.worstLoss };
    st.closed.unshift(rec); if (st.closed.length > 200) st.closed.length = 200;
    st.capital += rec.net; st.pos = null;
    this.store.push('trades', rec).catch(() => {});
    this.log(`CLOSED condor ${pos.expiry}: ${reason}. Net Rs ${Math.round(rec.net)} (${rec.r.toFixed(2)} of the worst case).`, now);
  }

  snapshot() {
    const st = this.state; if (!st) return { enabled: true, loading: true };
    return { enabled: true, capital: st.capital, status: st.status, position: st.pos, closed: st.closed.slice(0, 20), events: st.events.slice(0, 25), snaps: st.snaps, skipped: st.skippedWeeks.slice(0, 5), lot: this.cfg.fnoLot || 65, maxRiskPct: this.cfg.fnoMaxRiskPct || 25 };
  }
}

module.exports = { FnoBook, planCondor, closeCost, closeLegs, settleLegs, costOf, charges, round50 };
