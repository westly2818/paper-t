// "Shadow" setup score: computed and stored for every trade, but it never blocks or changes a trade.
// Later, compare score against results to find which signals and which cutoff really separate
// winners from losers, then decide whether to start using it. Weights are a first guess.
// Not available yet (stored as null so the data shows the gap): sector strength, fresh catalyst,
// price structure (higher highs/lows).
const WEIGHTS = { trendAligned: 2, volume2x: 2, vwap: 1, breakout: 2, relStrength: 1, prevDayBreak: 1, niftyAgrees: 1 };
const MAX = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);

function scoreSetup(s) {
  const dir = s.dir;
  const parts = {
    trendAligned: s.planBias === (dir === 1 ? 'bull' : 'bear'),
    volume2x: s.volRatio != null && s.volRatio >= 2,
    vwap: true,       // required by the entry rules, listed so a later rule change shows up in the data
    breakout: true,   // same
    relStrength: s.relStrength != null && s.relStrength > 0,
    prevDayBreak: s.prevDayBreak === true,
    niftyAgrees: s.niftyAgrees === true
  };
  let score = 0;
  for (const [k, v] of Object.entries(parts)) if (v) score += WEIGHTS[k];
  // Provisional tiers: re-derive them from the stored parts once there are enough trades.
  const grade = score >= 8 ? 'A' : score >= 6 ? 'B' : 'C';
  return { score, max: MAX, grade, parts, weights: WEIGHTS, notAvailable: ['sector', 'catalyst', 'structure'] };
}

module.exports = { scoreSetup, WEIGHTS, MAX };
