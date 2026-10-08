// The verdict rules for "is this method really working?", shared by decide.js and tested on their own.
// FROZEN (do not change after looking at results): gate and bands.
const V = require('./validate');

const GATE = { trades: 30, days: 15, up: 4, down: 4 };
const BANDS = [[0.90, 'STRONG evidence it works'], [0.75, 'LIKELY works'], [0.60, 'LEANING YES (keep collecting, add no money)'], [0.40, 'UNCLEAR'], [0, 'LEANING NO']];

// rows: [{ day, excess, r, bench, kind }], kind = 'up' | 'down' | 'flat' (what Nifty did that day)
function judge(rows, gate = GATE, opts = {}) {
  const days = rows.map(r => r.day), dayList = [...new Set(days)];
  const ex = V.clusterBootstrap(rows.map(r => r.excess), days, opts), raw = V.clusterBootstrap(rows.map(r => r.r), days, opts);
  const up = dayList.filter(d => rows.find(r => r.day === d).kind === 'up').length, down = dayList.filter(d => rows.find(r => r.day === d).kind === 'down').length;
  const confidence = ex.probMeanAboveZero;
  let band = BANDS.find(([min]) => confidence >= min)[1];
  if (confidence >= 0.60 && ex.mean <= 0) band = 'UNCLEAR (confidence is high but the average excess is not above zero)';
  const missing = [];
  if (rows.length < gate.trades) missing.push(`${gate.trades - rows.length} more trades`);
  if (dayList.length < gate.days) missing.push(`${gate.days - dayList.length} more trading days`);
  if (up < gate.up) missing.push(`${gate.up - up} more up days`);
  if (down < gate.down) missing.push(`${gate.down - down} more down days`);
  return { n: rows.length, days: dayList.length, up, down, flat: dayList.length - up - down, excess: ex, raw, confidence, band, gateOk: missing.length === 0, missing,
    winRate: rows.filter(r => r.net > 0).length / rows.length };
}

// Measured by simulation (200 methods with NO edge, 200 with a real +0.15R edge; 100 trades on 40 days):
// a method with no edge still reads >=60% about 33-41% of the time, >=75% about 22-29%, >=90% about 11-15%, and this does NOT
// improve with more data. A real +0.15R edge reads >=75% 86% of the time at 100 trades (98% at 300) and >=90% 70% (93% at 300).
const FALSE_ALARM = { 0.60: 0.37, 0.75: 0.25, 0.90: 0.13 };

module.exports = { judge, GATE, BANDS, FALSE_ALARM };
