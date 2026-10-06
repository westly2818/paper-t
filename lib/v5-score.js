// Momentum Strategy V5: scoring logic
// 1. Pre-market score (0-100) to select top 6 stocks from Nifty 200 before open:
//    - News / catalyst: 20
//    - Pre-open gap: 20
//    - Previous-day strength: 15
//    - ATR / range: 15
//    - Liquidity / turnover: 15
//    - Sector / Market RS: 15
//
// 2. Live Momentum score (0-100) evaluated continuously from 9:15 onward:
//    - 25% Relative Strength (vs Nifty)
//    - 20% RVOL (volume vs stock's historical/expected volume)
//    - 20% Intraday Trend (EMA 9 vs EMA 21)
//    - 15% VWAP Position (price vs VWAP)
//    - 10% Sector / Market Strength
//    - 10% Breakout Structure / Range Position

const clamp01 = x => Math.max(0, Math.min(1, x));

// ---------------------------------------------------------------------------
// Pre-market scoring (0 - 100 points)
// ---------------------------------------------------------------------------
function preMarketScore(info, niftyDaily = null, opts = {}) {
  // info has { sym, close, prevHigh, prevLow, turnover, atr, atrPct, mom5, bias, rsi, ema20, ema50, gapPct, catalyst }
  const {
    catalystWeight = 20,
    gapWeight = 20,
    prevDayWeight = 15,
    atrWeight = 15,
    turnoverWeight = 15,
    sectorRsWeight = 15
  } = opts;

  // 1. News / Catalyst (20 pts)
  let newsPts = 0;
  if (info.catalyst) {
    if (info.catalyst.verified && info.catalyst.explainsMove) newsPts = catalystWeight;
    else if (info.catalyst.category) newsPts = catalystWeight * 0.7;
    else newsPts = catalystWeight * 0.4;
  } else if (info.newsSentiment != null) {
    newsPts = catalystWeight * clamp01(info.newsSentiment);
  } else {
    // If no catalyst check available, give neutral base credit if strong 1-day jump
    const absGap = Math.abs(info.gapPct || 0);
    newsPts = absGap >= 1.5 ? catalystWeight * 0.5 : catalystWeight * 0.25;
  }

  // 2. Pre-open Gap (20 pts)
  // Optimal gap is 1% to 3.5%; <0.3% has little juice, >5% risks fading
  const absGap = Math.abs(info.gapPct || 0);
  let gapPts = 0;
  if (absGap >= 0.5 && absGap <= 4.0) {
    gapPts = gapWeight * clamp01((absGap - 0.5) / 2.0);
  } else if (absGap > 4.0) {
    gapPts = gapWeight * Math.max(0.2, 1 - (absGap - 4.0) / 4.0);
  }

  // 3. Previous-Day Strength (15 pts)
  // Strong trend on daily chart: price > ema20 > ema50, RSI between 55 and 75, positive 5-day momentum
  let prevPts = 0;
  if (info.bias === 'bull') {
    const rsiScore = info.rsi ? clamp01((info.rsi - 45) / 25) : 0.5;
    const momScore = info.mom5 ? clamp01(info.mom5 / 4) : 0.5;
    prevPts = prevDayWeight * (0.5 * rsiScore + 0.5 * momScore);
  } else if (info.bias === 'bear') {
    const rsiScore = info.rsi ? clamp01((55 - info.rsi) / 25) : 0.5;
    const momScore = info.mom5 ? clamp01(-info.mom5 / 4) : 0.5;
    prevPts = prevDayWeight * (0.5 * rsiScore + 0.5 * momScore);
  } else {
    prevPts = prevDayWeight * 0.3;
  }

  // 4. ATR / Range (15 pts)
  // Needs enough intraday range: 1.5% to 3.5% ideal
  const atrPct = info.atrPct || 0;
  let atrPts = 0;
  if (atrPct >= 1.0 && atrPct <= 4.5) {
    atrPts = atrWeight * clamp01((atrPct - 1.0) / 1.5);
    if (atrPct > 3.5) atrPts *= Math.max(0.6, 1 - (atrPct - 3.5) / 2);
  }

  // 5. Liquidity / Turnover (15 pts)
  // Higher turnover means tighter spreads and cleaner momentum
  // minTurnover = 3e8 (30 Cr), top tier = 15e8 (150 Cr)
  const to = info.turnover || 0;
  const turnoverPts = turnoverWeight * clamp01((to - 2e8) / 8e8);

  // 6. Sector / Market Relative Strength (15 pts)
  let rsPts = 0;
  if (niftyDaily && niftyDaily.length >= 6 && info.mom5 != null) {
    const nLast = niftyDaily[niftyDaily.length - 1];
    const nPrev5 = niftyDaily[niftyDaily.length - 6];
    const nMom5 = (nLast.c / nPrev5.c - 1) * 100;
    const relMom = info.bias === 'bear' ? -(info.mom5 - nMom5) : (info.mom5 - nMom5);
    rsPts = sectorRsWeight * clamp01((relMom + 2) / 6);
  } else {
    rsPts = sectorRsWeight * 0.5;
  }

  const total = newsPts + gapPts + prevPts + atrPts + turnoverPts + rsPts;

  return {
    score: Math.round(total * 10) / 10,
    parts: {
      catalyst: Math.round(newsPts * 10) / 10,
      gap: Math.round(gapPts * 10) / 10,
      prevDay: Math.round(prevPts * 10) / 10,
      atr: Math.round(atrPts * 10) / 10,
      turnover: Math.round(turnoverPts * 10) / 10,
      sectorRs: Math.round(rsPts * 10) / 10
    }
  };
}

// Rank pre-market candidates and select top N (default 6)
function rankPremarket(candidates, niftyDaily = null, topN = 6) {
  const scored = candidates.map(c => {
    const s = preMarketScore(c, niftyDaily);
    return { ...c, preScore: s.score, preParts: s.parts };
  });
  scored.sort((a, b) => b.preScore - a.preScore);
  return {
    picked: scored.slice(0, topN),
    rest: scored.slice(topN)
  };
}

// ---------------------------------------------------------------------------
// Live Momentum scoring (0 - 100 points)
// ---------------------------------------------------------------------------
// ctx: {
//   c,             // current price
//   vw,            // current VWAP
//   e9,            // 9-period EMA on 5m
//   e21,           // 21-period EMA on 5m
//   rvol,          // cumulative or candle RVOL
//   chg,           // stock return from prev close (%)
//   nchg,          // Nifty return from prev close (%)
//   nIntraChg,     // Nifty intraday return from open (%)
//   rangePos,      // position within recent high-low span [0, 1]
//   dir            // trade direction (1 = long, -1 = short)
// }
function liveScore({
  c,
  vw,
  e9,
  e21,
  rvol = 1,
  chg = 0,
  nchg = 0,
  nIntraChg = 0,
  rangePos = 0.5,
  dir = 1
}) {
  // 1. Relative Strength vs Nifty: 25%
  // Stock beating Nifty by 1.5% gives full marks
  const rsDiff = dir * (chg - nchg);
  const rs = 25 * clamp01(rsDiff / 1.5);

  // 2. RVOL: 20%
  // RVOL from 0.8x to 2.0x scales to 20 pts (at 2.0x RVOL gives max points)
  const vol = 20 * clamp01((rvol - 0.8) / 1.2);

  // 3. Intraday Trend (EMA9 vs EMA21): 20%
  // Difference between EMA9 and EMA21 normalized by price (0.3% separation = max)
  const trendSep = dir * (e9 - e21) / (c || 1);
  const trend = 20 * clamp01(trendSep / 0.003);

  // 4. VWAP Position: 15%
  // Distance from VWAP in trade direction (0.3% above VWAP = max)
  const vwapDist = dir * (c - vw) / (c || 1);
  const vwap = 15 * clamp01(vwapDist / 0.003);

  // 5. Sector / Market Strength: 10%
  // Market moving in our trade direction
  const mkt = 10 * clamp01(dir * nIntraChg / 0.3);

  // 6. Breakout Structure / Range Position: 10%
  // Longs want price near upper end of recent range (>0.85); shorts near bottom (<0.15)
  const directionalPos = dir === 1 ? rangePos : (1 - rangePos);
  const pos = 10 * clamp01((directionalPos - 0.5) / 0.4);

  const total = rs + vol + trend + vwap + mkt + pos;

  return {
    score: Math.round(total * 10) / 10,
    parts: {
      relativeStrength: Math.round(rs * 10) / 10,
      rvol: Math.round(vol * 10) / 10,
      trend: Math.round(trend * 10) / 10,
      vwap: Math.round(vwap * 10) / 10,
      market: Math.round(mkt * 10) / 10,
      structure: Math.round(pos * 10) / 10
    }
  };
}

module.exports = {
  clamp01,
  preMarketScore,
  rankPremarket,
  liveScore
};
