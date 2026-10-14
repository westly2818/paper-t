// ISS paper book: the "Intraday Short Straddle". PAPER ONLY, nothing is ever sent to a broker.
// Each trading day at 10:00 it sells the at-the-money NIFTY call and put of the nearest weekly expiry and gives each leg its own stop.
// Unlike the history test (straddle-sim.js), which MODELS option prices, this book uses the REAL bid and ask from the Fyers option chain,
// so after a few weeks it shows what the rules earn with real fills, and it records the real ATM straddle quote every 30 minutes
// so the pricing model behind the history test can be checked against reality.
// Data: same as the F&O book (Fyers option chain + token). No token = the tab says so and nothing trades.
// Rules (frozen, taken from the strategy's author and the straddle-sim.js grid):
//   enter   from 10:00, once a day, until 10:30 (a later start skips the day so the rules stay the same), nearest weekly expiry, ATM strike (50-point step)
//   fills   SELL both legs at the bid; every buy-back at the ask (no mid-price flattery)
//   stop    each leg on its own: buy it back when its ask reaches (1 + 40%) x its sale price; the other leg stays open
//   exit    whatever is still open is bought back at 15:00
//   size    one lot (65), no scaling after a loss. Reference margin Rs 2,00,000 for the % figures.
//   checks  a stop is judged on the one-minute tick, so a fast spike can fill worse than the trigger, as it would in real life
const { dayKey, minOfDay, isWeekday } = require('./time');
const { Store } = require('./store');
const { FnoBook } = require('./fno');
const { charges } = require('./straddle');

const STEP = 50, SL = 0.4, ENTRY_FROM = 10 * 60, ENTRY_TO = 10 * 60 + 30, EXIT_AT = 15 * 60, SNAP_EVERY = 30;
const round50 = x => Math.round(x / STEP) * STEP;
const rowOf = (rows, strike, type) => rows.find(r => r.strike === strike && r.type === type);

// Pure rules, so they can be tested without a market.
function planStraddle(chain, lot) {
  const K = round50(chain.spot), ce = rowOf(chain.rows, K, 'CE'), pe = rowOf(chain.rows, K, 'PE');
  if (!ce || !pe) return { ok: false, why: `no ${K} strike in the option chain` };
  if (!(ce.bid > 0) || !(pe.bid > 0)) return { ok: false, why: 'no bid on the at-the-money options' };
  if (!(ce.ask > 0) || !(pe.ask > 0)) return { ok: false, why: 'no ask on the at-the-money options' };
  const legs = [ce, pe].map(r => ({ type: r.type, strike: K, sold: r.bid, askAtEntry: r.ask, trigger: r.bid * (1 + SL), open: true, exit: null, why: null }));
  return { ok: true, K, legs, premium: legs[0].sold + legs[1].sold, spreadPts: (ce.ask - ce.bid) + (pe.ask - pe.bid), qty: lot };
}
// One look at the quotes for an open position. Returns the legs that must be bought back now, with the price and reason.
function checkExits(pos, rows, mod) {
  const out = [];
  for (const L of pos.legs) {
    if (!L.open) continue;
    const r = rowOf(rows, L.strike, L.type); if (!r || !(r.ask > 0)) continue;
    L.ask = r.ask; L.bid = r.bid;
    if (mod >= EXIT_AT) out.push({ leg: L, price: r.ask, why: 'time exit 15:00' });
    else if (r.ask >= L.trigger) out.push({ leg: L, price: r.ask, why: r.ask > L.trigger * 1.02 ? 'stop (filled above the trigger)' : 'stop' });
  }
  return out;
}

class IssBook extends FnoBook {
  constructor(cfg, opts = {}) { super(cfg, { ...opts, store: opts.store || new Store(cfg, 'iss') }); }
  fresh() { return { pos: null, closed: [], events: [], quotes: 0, lastQuote: 0, lastEntryDay: null, status: { token: 'unknown' }, skippedDays: [] }; }
  async load() { this.state = (await this.store.get('state')) || this.fresh(); }
  lot() { return this.cfg.fnoLot || 65; }

  async _tick(now) {
    const st = this.state, day = dayKey(now), mod = minOfDay(now);
    // an old position the server was not running for: close it at the last quotes seen
    if (st.pos && st.pos.day < day) this.closeAll(st.pos, 'server was off at the 15:00 exit: closed at the last quotes seen', now, true);
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
    const near = this.nearestExpiry(ch.expiries, now)[0];
    st.status = { token: 'ok', phase: 'live', spot: ch.spot, vix: ch.vix, expiry: near ? near.date : null, daysToExpiry: near ? near.days : null, updatedAt: now, note: '' };
    if (!near || !(ch.spot > 0)) return;

    // real ATM straddle quote every 30 minutes (09:30, 10:00, ... 15:00), to check the pricing model against reality
    const slot = Math.floor(mod / SNAP_EVERY);
    if (mod >= 9 * 60 + 30 && mod <= EXIT_AT + 15 && st.lastQuote !== `${day}:${slot}`) {
      const K = round50(ch.spot), ce = rowOf(ch.rows, K, 'CE'), pe = rowOf(ch.rows, K, 'PE');
      if (ce && pe) { await this.store.push('quotes', { day, t: now, mod, spot: ch.spot, vix: ch.vix, expiry: near.date, daysToExpiry: near.days, K, ce: [ce.bid, ce.ask, ce.ltp], pe: [pe.bid, pe.ask, pe.ltp] }); st.quotes++; st.lastQuote = `${day}:${slot}`; }
    }

    if (st.pos) { await this.manageIss(token, st.pos, ch, near, now, mod); }
    else if (st.lastEntryDay !== day && mod >= ENTRY_FROM) {
      st.lastEntryDay = day;
      if (mod > ENTRY_TO) { this.skip(day, near.date, `started too late (${Math.floor(mod / 60)}:${String(mod % 60).padStart(2, '0')}); entries are only taken 10:00 to 10:30`, now); }
      else {
        const plan = planStraddle(ch, this.lot());
        if (!plan.ok) this.skip(day, near.date, plan.why, now);
        else {
          const fills = plan.legs.map(l => ({ side: 'SELL', value: l.sold * plan.qty }));
          st.pos = { id: st.closed.length + 1, day, t: now, expiry: near.date, expiryKey: near.key, daysToExpiry: near.days, K: plan.K, qty: plan.qty, premium: plan.premium, spreadPts: plan.spreadPts, spotIn: ch.spot, vixIn: ch.vix, legs: plan.legs, fills };
          this.log(`SOLD straddle ${plan.K} (expiry ${near.date}, ${near.days} d): CE ${plan.legs[0].sold} + PE ${plan.legs[1].sold} = ${plan.premium.toFixed(1)} pts (Rs ${Math.round(plan.premium * plan.qty).toLocaleString('en-IN')}); stops at +40% per leg.`, now);
        }
      }
    }
    await this.save();
  }

  skip(day, expiry, why, now) { const st = this.state; this.log(`No straddle today: ${why}.`, now); st.skippedDays.unshift({ day, expiry, why }); st.skippedDays.length = Math.min(st.skippedDays.length, 20); }

  async manageIss(token, pos, ch, near, now, mod) {
    let rows = ch.rows;
    if (near && near.date !== pos.expiry) { try { const full = await this.chain(token, (ch.expiries.find(e => e.date === pos.expiry) || {}).expiry); rows = full.rows; } catch (_) { return; } }
    for (const x of checkExits(pos, rows, mod)) this.closeLeg(pos, x.leg, x.price, x.why, now);
    if (pos.legs.every(L => !L.open)) { this.finish(pos, now); return; }
    // open P/L at the buy-back (ask) prices
    pos.mtm = pos.legs.reduce((a, L) => a + (L.sold - (L.open ? (L.ask || L.sold) : L.exit)), 0) * pos.qty; pos.spot = ch.spot; pos.updatedAt = now;
  }
  closeLeg(pos, L, price, why, now) {
    L.open = false; L.exit = price; L.why = why; L.exitT = now; pos.fills.push({ side: 'BUY', value: price * pos.qty });
    this.log(`BOUGHT BACK ${L.type} ${L.strike} at ${price}: ${why} (sold ${L.sold}, ${((price / L.sold - 1) * 100).toFixed(0)}% ${price > L.sold ? 'higher' : 'lower'}).`, now);
  }
  closeAll(pos, why, now, stale) {
    for (const L of pos.legs) if (L.open) this.closeLeg(pos, L, L.ask || L.sold, why, now);
    this.finish(pos, now, stale);
  }
  finish(pos, now, stale) {
    const st = this.state, points = pos.legs.reduce((a, L) => a + (L.sold - L.exit), 0), gross = points * pos.qty;
    const fee = charges(pos.fills, { stt: 0.0015 }), net = gross - fee;
    const rec = { ...pos, exitT: now, exitDay: dayKey(now), points, gross, fees: fee, net, stops: pos.legs.filter(L => /^stop/.test(L.why || '')).length, stale: !!stale };
    st.closed.unshift(rec); if (st.closed.length > 300) st.closed.length = 300;
    st.pos = null; this.store.push('trades', rec).catch(() => {});
    this.log(`CLOSED straddle ${pos.K}: ${points.toFixed(1)} pts, net Rs ${Math.round(net)} after charges (${rec.stops} leg stop${rec.stops === 1 ? '' : 's'}).`, now);
  }

  snapshot() {
    const st = this.state; if (!st) return { enabled: true, loading: true };
    const done = st.closed, wins = done.filter(c => c.net > 0).length, total = done.reduce((a, c) => a + c.net, 0);
    let cum = 0, peak = 0, dd = 0; for (const c of done.slice().reverse()) { cum += c.net; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
    return { enabled: true, status: st.status, position: st.pos, closed: done.slice(0, 30), events: st.events.slice(0, 30), quotes: st.quotes, skipped: st.skippedDays.slice(0, 8), lot: this.lot(), margin: this.cfg.issMargin || 200000,
      totals: { days: done.length, wins, net: total, avg: done.length ? total / done.length : null, maxDrawdown: dd } };
  }
}

module.exports = { IssBook, planStraddle, checkExits, SL, ENTRY_FROM, ENTRY_TO, EXIT_AT };
