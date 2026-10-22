// DEPLOYMENT GATE: quantitative acceptance criteria that a strategy must meet before it is even eligible for a separately authorised, limited-risk live trial.
// LOCKED 22 Oct 2026, before any strategy was judged against it. Do not lower a threshold to make a strategy pass: change it only with a dated note in docs/DEPLOYMENT_GATE.md.
// Pure functions (no network); cycle-report.js feeds them live trade records. R = profit or loss divided by the amount risked at the stop.
const GATE = {
  minTrades: 100, minDays: 40,                 // G3: sample and regime coverage
  minUpDays: 5, minDownDays: 5, flatPct: 0.3,  //     up/down day = Nifty close-to-close beyond +-0.3%
  minAvgR: 0.10, minT: 2,                      // G1: average R after charges AND the cautious stop-slippage estimate; day-clustered t
  minGoodWeeks: 0.6, minWeeks: 4,              // G2: share of calendar weeks with positive R (after slippage), and both chronological halves positive
  maxDrawdownR: 10, maxLosingStreak: 8,        // G4: observed on the same trades
  extraChargesFactor: 0.5,                     // G5: average R must stay > 0 with charges 50% higher
  maxTop10Share: 0.5, maxSymbolShare: 0.25,    // G6: best 10 trades <= 50% of the gross profit; no single stock > 25% of it
  histMinTrades: 200, histMinYears: 2,         // G0: historical out-of-sample evidence needed (positive after costs in development AND holdout)
};

const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const isoWeek = day => { const d = new Date(day + 'T00:00:00Z'); const t = new Date(Date.UTC(d.getUTCFullYear(), 0, 1)); return d.getUTCFullYear() + '-W' + String(Math.floor(((d - t) / 86400000 + t.getUTCDay() + 1) / 7)).padStart(2, '0'); };

function dayClusteredT(rows, key = 'r') {
  const by = new Map(); for (const r of rows) { if (!by.has(r.day)) by.set(r.day, []); by.get(r.day).push(r[key]); }
  const v = [...by.values()].map(mean); if (v.length < 3) return null;
  const m = mean(v), sd = Math.sqrt(mean(v.map(x => (x - m) ** 2)) * v.length / (v.length - 1));
  return sd > 0 ? m / (sd / Math.sqrt(v.length)) : null;
}

// rows: [{ day, sym, opened, r (after charges and slippage), chargesR (charges in R) }]; kindByDay: { day: 'up' | 'down' | 'flat' }
function metrics(rows, kindByDay = {}) {
  const t = rows.slice().sort((a, b) => a.opened - b.opened), n = t.length;
  if (!n) return { n: 0 };
  const days = [...new Set(t.map(x => x.day))];
  let cum = 0, peak = 0, dd = 0, streak = 0, worst = 0;
  for (const x of t) { cum += x.r; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); streak = x.r < 0 ? streak + 1 : 0; worst = Math.max(worst, streak); }
  const weeks = new Map(); for (const x of t) weeks.set(isoWeek(x.day), (weeks.get(isoWeek(x.day)) || 0) + x.r);
  const half = Math.floor(n / 2), pos = t.filter(x => x.r > 0), grossProfit = pos.reduce((a, x) => a + x.r, 0);
  const top10 = pos.map(x => x.r).sort((a, b) => b - a).slice(0, 10).reduce((a, x) => a + x, 0);
  const bySym = new Map(); for (const x of pos) bySym.set(x.sym, (bySym.get(x.sym) || 0) + x.r);
  return {
    n, days: days.length, avgR: mean(t.map(x => x.r)), t: dayClusteredT(t),
    firstHalfR: mean(t.slice(0, half).map(x => x.r)), secondHalfR: mean(t.slice(half).map(x => x.r)),
    weeks: weeks.size, goodWeeks: weeks.size ? [...weeks.values()].filter(x => x > 0).length / weeks.size : 0,
    maxDrawdownR: dd, maxLosingStreak: worst,
    avgRMoreCharges: mean(t.map(x => x.r - GATE.extraChargesFactor * (x.chargesR || 0))),
    top10Share: grossProfit > 0 ? top10 / grossProfit : null, maxSymbolShare: grossProfit > 0 ? Math.max(...bySym.values()) / grossProfit : null,
    upDays: days.filter(d => kindByDay[d] === 'up').length, downDays: days.filter(d => kindByDay[d] === 'down').length,
  };
}

// ledger: { hist: { trades, years, devAvgR, holdAvgR, source }|null, attest: { leakageReviewed, paperMatchesTest }|null }
function evaluate(m, ledger = {}) {
  const C = [];
  const add = (id, name, ok, detail) => C.push({ id, name, status: ok === null ? 'UNAVAILABLE' : ok ? 'PASS' : 'FAIL', detail });
  const h = ledger.hist;
  add('G0', 'historical out-of-sample evidence positive after costs (>= 200 trades, >= 2 years, development AND holdout)',
    h ? (h.trades >= GATE.histMinTrades && h.years >= GATE.histMinYears && h.devAvgR > 0 && h.holdAvgR > 0) : null,
    h ? `${h.trades.toLocaleString('en-IN')} trades over ${h.years} years: development ${h.devAvgR.toFixed(3)}R, holdout ${h.holdAvgR.toFixed(3)}R (${h.source})` : 'no historical test of the exact rules exists');
  if (!m.n) { add('G1', 'live/forward sample', false, 'no trades'); return C; }
  const f = (v, d = 2) => (v == null ? 'n/a' : v.toFixed(d));
  add('G1', `forward expectancy after charges and slippage >= +${GATE.minAvgR}R, day-clustered t >= ${GATE.minT}, at least ${GATE.minTrades} trades`, m.n >= GATE.minTrades && m.avgR >= GATE.minAvgR && m.t != null && m.t >= GATE.minT,
    `${m.n} trades, ${f(m.avgR, 3)}R, t ${f(m.t)}`);
  add('G2', `stable over time: both halves > 0, at least ${GATE.minWeeks} weeks and >= ${GATE.minGoodWeeks * 100}% of them positive`, m.n >= 4 && m.firstHalfR > 0 && m.secondHalfR > 0 && m.weeks >= GATE.minWeeks && m.goodWeeks >= GATE.minGoodWeeks,
    `halves ${f(m.firstHalfR)}R / ${f(m.secondHalfR)}R, ${m.weeks} weeks, ${(m.goodWeeks * 100).toFixed(0)}% positive`);
  add('G3', `sample and regimes: >= ${GATE.minTrades} trades, >= ${GATE.minDays} days, >= ${GATE.minUpDays} up and >= ${GATE.minDownDays} down days`, m.n >= GATE.minTrades && m.days >= GATE.minDays && m.upDays >= GATE.minUpDays && m.downDays >= GATE.minDownDays,
    `${m.n} trades, ${m.days} days, ${m.upDays} up, ${m.downDays} down`);
  add('G4', `drawdown <= ${GATE.maxDrawdownR}R and longest losing streak <= ${GATE.maxLosingStreak}`, m.maxDrawdownR <= GATE.maxDrawdownR && m.maxLosingStreak <= GATE.maxLosingStreak, `drawdown ${f(m.maxDrawdownR, 1)}R, streak ${m.maxLosingStreak}`);
  add('G5', `still positive with charges +${GATE.extraChargesFactor * 100}% (the stop-slippage estimate is already in G1)`, m.avgRMoreCharges > 0, `${f(m.avgRMoreCharges, 3)}R`);
  add('G6', `not a lottery: best 10 trades <= ${GATE.maxTop10Share * 100}% and one stock <= ${GATE.maxSymbolShare * 100}% of the gross profit`, m.top10Share != null && m.top10Share <= GATE.maxTop10Share && m.maxSymbolShare <= GATE.maxSymbolShare,
    m.top10Share == null ? 'no gross profit' : `top 10 ${(m.top10Share * 100).toFixed(0)}%, largest stock ${(m.maxSymbolShare * 100).toFixed(0)}%`);
  const a = ledger.attest || {};
  add('G7', 'no look-ahead, leakage or selection bias (rules frozen before the evaluation window, reviewed)', a.leakageReviewed == null ? null : !!a.leakageReviewed, a.leakageReviewed == null ? 'not attested' : String(a.leakageReviewed));
  add('G8', 'paper/shadow results consistent with the tested assumptions (needs a positive G0 test to be consistent with)', a.paperMatchesTest == null ? null : !!a.paperMatchesTest, a.paperMatchesTest == null ? 'not attested' : String(a.paperMatchesTest));
  return C;
}

// Disposition rules (fixed): a failed G0 on a large sample is a REJECT, not "keep collecting".
function disposition(criteria, { shadow = false, evidenceKind = 'trades' } = {}) {
  const by = Object.fromEntries(criteria.map(c => [c.id, c]));
  if (by.G0 && by.G0.status === 'FAIL') return { code: 'REJECT STRATEGY', why: 'historical out-of-sample evidence is negative or too weak after costs: ' + by.G0.detail };
  const unmet = criteria.filter(c => c.status !== 'PASS');
  if (!unmet.length) return { code: 'DEPLOYMENT GATE PASSED', why: 'eligible only for a separately authorised, limited-risk live trial with a human approval gate' };
  return { code: shadow ? 'KEEP IN SHADOW' : 'KEEP IN PAPER', why: 'missing: ' + unmet.map(c => `${c.id} (${c.status.toLowerCase()}: ${c.detail})`).join('; ') };
}

// Informational market label for the cycle report (NOT a trade filter): from the Nifty 5-minute bars of the day and India VIX.
function marketStatus(bars, vix, { vixHigh = 24 } = {}) {
  if (!bars || bars.length < 12) return { label: 'UNCERTAIN', why: 'fewer than 12 five-minute bars of Nifty' };
  const o = bars[0][1], c = bars[bars.length - 1][4], hi = Math.max(...bars.map(b => b[2])), lo = Math.min(...bars.map(b => b[3]));
  const rangePct = (hi - lo) / o * 100, eff = hi > lo ? Math.abs(c - o) / (hi - lo) : 0;
  const base = `Nifty range ${rangePct.toFixed(2)}%, net move ${((c - o) / o * 100).toFixed(2)}%, efficiency ${eff.toFixed(2)}${vix != null ? `, VIX ${vix.toFixed(1)}` : ''}`;
  if ((vix != null && vix >= vixHigh) || rangePct >= 2.5) return { label: 'HIGH VOLATILITY', why: base };
  if (eff >= 0.5 && rangePct >= 0.6) return { label: 'TRENDING', why: base };
  if (eff < 0.3) return { label: 'RANGING', why: base };
  return { label: 'UNCERTAIN', why: base };
}

module.exports = { GATE, metrics, evaluate, disposition, marketStatus, dayClusteredT };
