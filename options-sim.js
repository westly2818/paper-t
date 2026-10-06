// Rough history test for WEEKLY NIFTY IRON CONDORS (sell a put and a call, buy a further put and call as protection).
//   node options-sim.js [--hold 5] [--short 1.0] [--wing 1.0] [--stop 0] [--minvix 0] [--lot 65] [--from 2018-10-01]
// There is no history for expired option contracts at Fyers, so every option price here is MODELLED with Black-Scholes using
// India VIX as the volatility. Real prices differ (skew, wide spreads on fast days), so treat the result as an optimistic first
// look: if the modelled version does not make money, the real one will not either.
//   --hold N     trading days to hold (5 = about a week); entry and exit at daily closes
//   --short K    short strikes at K standard deviations of the VIX-implied move over the hold (1.0 = about 16 delta)
//   --wing W     protective strikes W percent of spot beyond the short strikes
//   --stop X     exit early when the position's loss reaches X times the credit received (0 = hold to the end), checked at daily closes
//   --minvix V   only trade when VIX is at or above V
// Costs: Rs 20 per order, option sell STT 0.15% of premium, exchange charges 0.035% of premium, 1 point of slippage per leg per side.
const fs = require('fs');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? +process.argv[i + 1] : d; };
const FROM = (() => { const i = process.argv.indexOf('--from'); return i > 0 ? process.argv[i + 1] : '2018-10-01'; })();
const HOLD = arg('hold', 5), SHORT = arg('short', 1.0), WING = arg('wing', 1.0), STOP = arg('stop', 0), MINVIX = arg('minvix', 0), LOT = arg('lot', 65), VERBOSE = process.argv.includes('--years');

const read = f => fs.readFileSync(f, 'utf8').split('\n').slice(1).filter(Boolean).map(l => { const r = l.split(','); return { d: r[0].slice(0, 10), c: +r[4] }; });
const nifty = read('data/fyers-daily-10y/NIFTY.csv'), vixM = new Map(read('data/fyers-daily-10y/INDIAVIX.csv').map(x => [x.d, x.c]));

const N = x => { const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
function price(type, S, K, T, iv) {
  if (T <= 0) return Math.max(type === 'C' ? S - K : K - S, 0);
  const sd = iv * Math.sqrt(T), d1 = (Math.log(S / K) + 0.5 * sd * sd) / sd, d2 = d1 - sd;
  return type === 'C' ? S * N(d1) - K * N(d2) : K * N(-d2) - S * N(-d1);   // zero interest rate: fine for a week
}
const round50 = x => Math.round(x / 50) * 50;
const TD = 252;

function condor(S, iv, T) {
  const move = S * iv * Math.sqrt(T), sk = round50(S + SHORT * move), sp = round50(S - SHORT * move), w = Math.max(50, round50(S * WING / 100));
  return { sc: sk, sp, lc: sk + w, lp: sp - w, w };
}
function value(c, S, iv, T) {   // cost to buy the whole condor back
  return price('C', S, c.sc, T, iv) + price('P', S, c.sp, T, iv) - price('C', S, c.lc, T, iv) - price('P', S, c.lp, T, iv);
}
const rows = [];
const days = nifty.filter(x => x.d >= FROM);
for (let i = 0; i + HOLD < days.length; i += HOLD) {
  const e = days[i], vix = vixM.get(e.d);
  if (!vix || vix < MINVIX) continue;
  const iv = vix / 100, T = HOLD / TD, c = condor(e.c, iv, T);
  const legs = [['C', c.sc, -1], ['P', c.sp, -1], ['C', c.lc, 1], ['P', c.lp, 1]];
  const slip = 1;                                           // points per leg per side
  // credit after slippage: we sell a bit lower and buy a bit higher
  const credit = legs.reduce((a, [t, k, q]) => a + (-q) * price(t, e.c, k, T, iv) - slip, 0);
  if (credit <= 1) continue;
  const sellPremEntry = price('C', e.c, c.sc, T, iv) + price('P', e.c, c.sp, T, iv);
  let exitIdx = i + HOLD, exitVal = null, stopped = false;
  for (let j = i + 1; j <= i + HOLD; j++) {
    const left = (HOLD - (j - i)) / TD, S = days[j].c, ivj = (vixM.get(days[j].d) || vix) / 100;
    const v = left <= 0 ? value(c, S, ivj, 0) : value(c, S, ivj, left);
    if (STOP > 0 && j < i + HOLD && v - credit >= STOP * credit) { exitIdx = j; exitVal = v; stopped = true; break; }
    if (j === i + HOLD) exitVal = v;
  }
  const exitCost = exitVal + (stopped ? 4 * slip : 4 * slip * 0);   // buying back costs a little more when we exit early
  const grossPts = credit - exitCost, gross = grossPts * LOT;
  const sellPremExit = stopped ? exitVal : Math.max(0, exitVal);
  const fees = 20 * (stopped ? 8 : 4) + 0.0015 * (sellPremEntry + (stopped ? Math.min(sellPremExit, exitVal) : 0)) * LOT + 0.00035 * (sellPremEntry + exitVal + credit) * LOT * 2;
  rows.push({ d: e.d, y: e.d.slice(0, 4), vix, S: e.c, credit, w: c.w, exitVal, stopped, net: gross - fees, maxLoss: (c.w - credit) * LOT, move: (days[exitIdx].c / e.c - 1) * 100 });
}

function stat(a) {
  if (!a.length) return null;
  const n = a.length, net = a.reduce((x, r) => x + r.net, 0), wins = a.filter(r => r.net > 0).length;
  let cum = 0, peak = 0, dd = 0; for (const r of a) { cum += r.net; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  const sorted = a.map(r => r.net).sort((x, y) => x - y);
  const m = net / n, sd = Math.sqrt(a.reduce((x, r) => x + (r.net - m) ** 2, 0) / (n - 1 || 1));
  return { n, wins: (wins / n * 100).toFixed(0) + '%', avg: m.toFixed(0), net: net.toFixed(0), worst: sorted[0].toFixed(0), best: sorted[n - 1].toFixed(0), dd: dd.toFixed(0), t: (m / (sd / Math.sqrt(n) || 1)).toFixed(2), credit: (a.reduce((x, r) => x + r.credit, 0) / n).toFixed(1), maxLoss: (a.reduce((x, r) => x + r.maxLoss, 0) / n).toFixed(0) };
}
console.log(`hold=${HOLD}d short=${SHORT}sd wing=${WING}% stop=${STOP} minvix=${MINVIX} lot=${LOT}  weeks=${rows.length}`);
console.log('ALL     ', JSON.stringify(stat(rows)));
if (VERBOSE) for (const y of [...new Set(rows.map(r => r.y))]) console.log(y.padEnd(8), JSON.stringify(stat(rows.filter(r => r.y === y))));
