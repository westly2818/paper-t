const { dayKey, hhmm } = require('./time');

// trades: any order. Returns the numbers a trader should track before trusting a strategy.
function tradeStats(list) {
  const trades = list.slice().sort((a, b) => a.tOut - b.tOut);
  const n = trades.length;
  const wins = trades.filter(t => t.net > 0), losses = trades.filter(t => t.net <= 0);
  const gw = wins.reduce((a, t) => a + t.net, 0), gl = -losses.reduce((a, t) => a + t.net, 0);
  let streak = 0, maxStreak = 0, cum = 0, peak = 0, maxDD = 0;
  for (const t of trades) {
    streak = t.net > 0 ? 0 : streak + 1; maxStreak = Math.max(maxStreak, streak);
    cum += t.net; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum);
  }
  const net = trades.reduce((a, t) => a + t.net, 0);
  return {
    trades: n, wins: wins.length, losses: losses.length,
    winRate: n ? (wins.length / n) * 100 : null,
    avgWin: wins.length ? gw / wins.length : null,
    avgLoss: losses.length ? -gl / losses.length : null,
    avgR: n ? trades.reduce((a, t) => a + t.r, 0) / n : null,
    expectancy: n ? net / n : null,
    profitFactor: gl > 0 ? gw / gl : gw > 0 ? Infinity : null,
    maxLossStreak: maxStreak, maxDrawdown: maxDD, net,
    fees: trades.reduce((a, t) => a + t.fees, 0),
    best: n ? Math.max(...trades.map(t => t.net)) : null, worst: n ? Math.min(...trades.map(t => t.net)) : null
  };
}

const q = v => `"${String(v).replace(/"/g, '""')}"`;
function toCsv(list) {
  const head = ['Date', 'Symbol', 'Side', 'Qty', 'Entry time', 'Entry', 'Stop', 'Target', 'Exit time', 'Exit', 'Entry value', 'Exit value', 'Exit reason', 'Gross', 'Charges', 'Net', 'R', 'Stop moved by trailing', 'Why entered'];
  const rows = list.slice().sort((a, b) => a.tIn - b.tIn).map(t => [
    dayKey(t.tIn), t.sym, t.side, t.qty, hhmm(t.tIn), t.entry.toFixed(2), t.sl0.toFixed(2), t.tp.toFixed(2), hhmm(t.tOut), t.exit.toFixed(2), (t.qty * t.entry).toFixed(2), (t.qty * t.exit).toFixed(2),
    q(t.reason), t.gross.toFixed(2), t.fees.toFixed(2), t.net.toFixed(2), t.r.toFixed(2), t.moved ? 'yes' : 'no', q(t.why || '')
  ].join(','));
  return [head.join(','), ...rows].join('\n');
}
// Flattens nested records (ctx.vwap, ctx.or.hi ...) into one spreadsheet row each.
function flatten(o, prefix, out) {
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? prefix + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = Array.isArray(v) ? JSON.stringify(v) : v;
  }
  return out;
}
function recordsToCsv(records) {
  const rows = records.map(r => flatten(r, '', {}));
  const cols = [...new Set(rows.flatMap(r => Object.keys(r)))];
  const cell = v => (v == null ? '' : typeof v === 'number' ? String(v) : q(v));
  return [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n');
}
module.exports = { tradeStats, toCsv, recordsToCsv };
