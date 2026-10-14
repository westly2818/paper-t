// Intraday short straddle ("ISS"): sell the ATM call and put of the current weekly Nifty expiry at 10:00, buy back a leg if it
// rises 30-40% above its sale price, exit what is left at 15:00. Simulated minute by minute on Nifty and India VIX 1-minute data,
// with option prices from Black-Scholes (implied volatility = scale x India VIX, scale calibrated on a real option chain).
const { price } = require('./bs');

const IST = 5.5 * 3600e3;
// Nifty weekly expiry: Thursday until 28 Aug 2025, Tuesday after (NSE moved it). A holiday moves the expiry to the day before.
function expiryFor(day, tradingDays, lastKnown) {
  const dow = day <= '2025-08-28' ? 4 : 2;
  let d = new Date(day + 'T00:00:00Z');
  while (d.getUTCDay() !== dow) d = new Date(d.getTime() + 86400e3);
  let e = d.toISOString().slice(0, 10);
  if (e > lastKnown) return e;                          // beyond our data: cannot check for holidays
  while (!tradingDays.has(e)) { d = new Date(d.getTime() - 86400e3); e = d.toISOString().slice(0, 10); }
  return e;
}
const expiryMs = e => Date.parse(e + 'T00:00:00Z') - IST + (15 * 60 + 30) * 60000;

// NSE option charges for one straddle round trip. fills = [{ side: 'SELL'|'BUY', value }] in rupees of premium turnover.
function charges(fills, o = {}) {
  const stt = o.stt ?? 0.001, txn = 0.0003503, sebi = 0.000001, stamp = 0.00003, brokerage = 20, gstRate = 0.18;
  let b = 0, s = 0, tx = 0, se = 0, st = 0, sellV = 0;
  for (const f of fills) { b += brokerage; tx += f.value * txn; se += f.value * sebi; if (f.side === 'BUY') st += f.value * stamp; else sellV += f.value; }
  s = sellV * stt;
  return b + s + tx + se + st + gstRate * (b + tx + se);
}

/* One day. m = { O,H,L,C } arrays of Nifty minutes 0..374 (09:15 = 0), vix = array of India VIX closes per minute.
   p = { expiry, slPct (0.4, or null for no stop), slip (0.01), ivScale (0.9), lot (65), entryMin (45 = 10:00), exitMin (345 = 15:00), r, stt } */
function simulateDay(m, vix, p) {
  // Time to expiry in years. 'trading' (default) counts only market time: the rest of today plus the full sessions left up to and including
  // the expiry day (p.remainingDays), over 252 sessions a year. 'calendar' counts every hour, weekends included.
  const T = (min) => p.clock === 'calendar' ? Math.max(0, (expiryMs(p.expiry) - (m.t0 + min * 60000)) / (365 * 86400e3))
    : Math.max(0, ((375 - Math.min(min, 375)) / 375 + (p.remainingDays || 0)) / 252);
  const sigma = min => (p.ivScale * vix[Math.min(Math.max(min - 1, 0), vix.length - 1)]) / 100;     // VIX of the previous minute close
  const leg = (type, K, spot, min) => price(type, spot, K, T(min), sigma(min), p.r ?? 0.065);
  const e0 = p.entryMin, spot0 = m.O[e0], K = Math.round(spot0 / 50) * 50;
  const legs = ['CE', 'PE'].map(type => { const px = leg(type, K, spot0, e0); return { type, entry: px, sold: px * (1 - p.slip), open: true, exit: null, why: null }; });
  if (!(legs[0].entry > 1 && legs[1].entry > 1)) return null;
  for (let j = e0; j <= p.exitMin; j++) {
    for (const L of legs) {
      if (!L.open) continue;
      if (j === p.exitMin) { L.exit = leg(L.type, K, m.O[j], j) * (1 + p.slip); L.open = false; L.why = 'time'; continue; }
      if (p.slPct == null) continue;
      const trig = L.entry * (1 + p.slPct), atOpen = leg(L.type, K, m.O[j], j), worst = leg(L.type, K, L.type === 'CE' ? m.H[j] : m.L[j], j);
      if (atOpen >= trig) { L.exit = atOpen * (1 + p.slip); L.open = false; L.why = 'stop (gap)'; }
      else if (worst >= trig) { L.exit = trig * (1 + p.slip); L.open = false; L.why = 'stop'; }
    }
    if (legs.every(L => !L.open)) break;
  }
  const lot = p.lot, points = legs.reduce((a, L) => a + (L.sold - L.exit), 0);
  const fills = []; for (const L of legs) { fills.push({ side: 'SELL', value: L.sold * lot }, { side: 'BUY', value: L.exit * lot }); }
  const fee = charges(fills, p), gross = points * lot;
  return { K, spot: spot0, entryPremium: legs[0].entry + legs[1].entry, points, gross, fee, net: gross - fee, legs: legs.map(L => ({ type: L.type, entry: L.entry, exit: L.exit, why: L.why })), stops: legs.filter(L => L.why && L.why.startsWith('stop')).length };
}

// Fit: the volatility scale (implied vol / India VIX) that reproduces a real ATM quote, under either clock.
function fitScale({ spot, K, type, mid, vix, minutesLeftToday, remainingDays, clock, expiry, tMs, r = 0.065 }) {
  const { impliedVol } = require('./bs');
  const T = clock === 'calendar' ? (expiryMs(expiry) - tMs) / (365 * 86400e3) : (minutesLeftToday / 375 + remainingDays) / 252;
  return impliedVol(type, spot, K, T, mid, r) / (vix / 100);
}

module.exports = { fitScale, simulateDay, expiryFor, expiryMs, charges, IST };
