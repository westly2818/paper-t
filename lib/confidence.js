// Confidence score for a trade setup, 0 to 100, shown in the Entry watch and stored with every signal and trade.
// It is a rule-based checklist score, NOT a probability of profit. It never blocks or changes a trade.
// Weights live only in this file. They were set by looking at 1,906 replayed trades (Oct 2024 to Oct 2026, no news check):
// daily trend and relative strength helped in both years, very high volume (2x or more) hurt, and a break of yesterday's
// high/low made no difference. The best fifth beat the worst fifth by only about 0.1R and no tier was profitable, so this is a
// way to see how many good signs line up, not a trading edge. It was calibrated on the same data it was checked on, so re-check
// it on live trades.
const WEIGHTS = { trend: 20, relStrength: 20, volume: 15, nifty: 15, vwap: 10, prevDay: 5, news: 10, risk: 5 };
const LABELS = {
  trend: 'Daily trend matches the trade', relStrength: 'Stronger (weaker) than Nifty, in the trade direction', volume: 'Healthy volume (above the minimum, under 2x average)',
  nifty: 'Nifty agrees', vwap: 'Right side of VWAP', prevDay: 'Beyond yesterday\'s high (low)', news: 'News check clear', risk: 'Normal-risk day'
};
const labelFor = score => (score >= 75 ? 'High' : score >= 50 ? 'Medium' : 'Low');

// s: { dir (1 long, -1 short), planBias, price, vwap, volRatio, minVol, niftyAgrees (true/false/null), relStrength (points, in the trade
//      direction, or null), prevDayBreak (true/false/null), newsOn, newsVerdict (true clear, false avoid, null unverified, undefined none), riskMult }
function buildConfidence(s) {
  const long = s.dir === 1, W = WEIGHTS, parts = [];
  const add = (key, points, why) => parts.push({ key, label: LABELS[key], points, max: W[key], why });

  const aligned = s.planBias === (long ? 'bull' : 'bear'), neutral = s.planBias === 'neutral';
  add('trend', aligned ? W.trend : neutral ? Math.round(W.trend * 0.4) : 0,
    aligned ? `The stock's daily trend is ${long ? 'up' : 'down'}, the same way as this ${long ? 'buy' : 'short'}.` : neutral ? 'The daily trend is neutral: partial credit.' : `The daily trend is ${long ? 'down' : 'up'}, against this ${long ? 'buy' : 'short'}.`);

  const rs = s.relStrength;
  add('relStrength', rs == null ? 0 : rs >= 0.5 ? W.relStrength : rs > 0 ? Math.round(W.relStrength * 0.55) : 0,
    rs == null ? 'Nifty data is not available yet.' : `Since the open the stock has moved ${rs >= 0 ? '' : '-'}${Math.abs(rs).toFixed(2)}% ${rs >= 0 ? 'more' : 'less'} than Nifty in this trade's direction.`);

  const vr = s.volRatio;
  add('volume', vr == null ? 0 : vr >= s.minVol && vr < 2 ? W.volume : 0,
    vr == null ? 'Not enough candles to compare volume yet.' : vr >= 2 ? `Volume is ${vr.toFixed(2)}x the day's average. Unusually high volume (2x or more) did worse in past replays, so no credit.` : vr >= s.minVol ? `Volume is ${vr.toFixed(2)}x the day's average, in the healthy range (${s.minVol}x to 2x).` : `Volume is ${vr.toFixed(2)}x the day's average, below the ${s.minVol}x needed.`);

  add('nifty', s.niftyAgrees === true ? W.nifty : s.niftyAgrees === null ? Math.round(W.nifty * 0.5) : 0,
    s.niftyAgrees === true ? `Nifty is ${long ? 'above' : 'below'} its VWAP, supporting this trade.` : s.niftyAgrees === null ? 'Nifty filter is off or Nifty data is missing: half credit.' : `Nifty is ${long ? 'below' : 'above'} its VWAP, against this trade.`);

  const vOk = long ? s.price > s.vwap : s.price < s.vwap;
  add('vwap', vOk ? W.vwap : 0, vOk ? `Price is ${long ? 'above' : 'below'} VWAP.` : `Price is on the wrong side of VWAP.`);

  add('prevDay', s.prevDayBreak === true ? W.prevDay : 0, s.prevDayBreak === true ? `Price is beyond yesterday's ${long ? 'high' : 'low'}, a fresh move.` : s.prevDayBreak === false ? `Price has not passed yesterday's ${long ? 'high' : 'low'}.` : 'Yesterday\'s range is not available.');

  const newsPts = !s.newsOn ? Math.round(W.news * 0.5) : s.newsVerdict === true ? W.news : 0;
  add('news', newsPts, !s.newsOn ? 'The news check is off: half credit.' : s.newsVerdict === true ? 'The news check found nothing against this stock.' : s.newsVerdict === false ? 'The news check says avoid this stock.' : 'The news check could not verify this stock.');

  add('risk', s.riskMult == null || s.riskMult >= 1 ? W.risk : 0, s.riskMult == null || s.riskMult >= 1 ? 'Volatility and market risk are normal today.' : `Risk is cut to ${Math.round(s.riskMult * 100)}% today (high VIX or an event day).`);

  const score = parts.reduce((a, p) => a + p.points, 0);
  return { score, label: labelFor(score), parts };
}

// Small form for storing: the labels and explanations can be rebuilt from the keys.
const compact = c => ({ score: c.score, label: c.label, parts: c.parts.map(p => ({ k: p.key, p: p.points, m: p.max })) });

module.exports = { buildConfidence, compact, WEIGHTS, LABELS, labelFor };
