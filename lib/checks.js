// Plain-English entry checklist for one leg of one stock. Used for what the bot saw at each closed
// 5-minute candle (the real decision), for the live preview, and stored with every trade so the
// dashboard can show exactly what was true, why, and against which threshold.
const f2 = n => Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// ok: true = passed, false = failed, null = not applicable right now.
function buildChecks(p) {
  const { side, leg, cfg, price, vwap, volRatio, idxState, chasePct, deadWhy, positions, trades, mod, live } = p;
  const long = side === 'long';
  const what = live ? 'Price' : 'Candle close';
  const checks = [];

  checks.push({
    key: 'window', label: 'Inside the entry window', ok: mod <= cfg.lastEntryMin,
    actual: hhmm(mod), required: `by ${hhmm(cfg.lastEntryMin)}`,
    why: mod <= cfg.lastEntryMin ? `${hhmm(mod)} is before the last entry time ${hhmm(cfg.lastEntryMin)}.` : `${hhmm(mod)} is after the last entry time ${hhmm(cfg.lastEntryMin)}, so no new trades are taken.`
  });
  checks.push({
    key: 'alive', label: 'Setup still valid', ok: !deadWhy,
    actual: deadWhy || 'stop and target untouched', required: 'stop and target not reached before entry',
    why: deadWhy ? `Setup is dead: ${deadWhy}.` : `Price has not touched the stop (${f2(leg.sl)}) or the target (${f2(leg.tp)}) since the range formed.`
  });
  const brk = long ? price > leg.trigger : price < leg.trigger;
  checks.push({
    key: 'breakout', label: `${what} ${long ? 'above the range high' : 'below the range low'}`, ok: brk,
    actual: f2(price), required: `${long ? 'above' : 'below'} ${f2(leg.trigger)}`,
    why: brk ? `${what} ${f2(price)} is ${long ? 'above' : 'below'} the trigger ${f2(leg.trigger)}: the opening range broke ${long ? 'upward' : 'downward'}.` : `${what} ${f2(price)} has not gone ${long ? 'above' : 'below'} the trigger ${f2(leg.trigger)} yet.`
  });
  const vOk = long ? price > vwap : price < vwap;
  checks.push({
    key: 'vwap', label: 'Right side of VWAP', ok: vOk,
    actual: `${f2(price)} vs VWAP ${f2(vwap)}`, required: `${long ? 'above' : 'below'} VWAP`,
    why: vOk ? `Price is ${long ? 'above' : 'below'} the day's average price, so ${long ? 'buyers' : 'sellers'} are in control.` : `Price is on the wrong side of the day's average price, so the move lacks backing.`
  });
  const volOk = volRatio == null ? null : volRatio >= cfg.minVolRatio;
  checks.push({
    key: 'volume', label: 'Volume strong enough', ok: volOk,
    actual: volRatio == null ? 'not enough data' : `${volRatio.toFixed(2)}x average`, required: `at least ${cfg.minVolRatio}x average`,
    why: volOk == null ? 'Not enough earlier candles to compare volume yet.' : volOk ? `This candle traded ${volRatio.toFixed(2)}x the day's average 5-minute volume, so there is real participation.` : `This candle traded only ${volRatio.toFixed(2)}x the average, below the ${cfg.minVolRatio}x needed, so the move may be false.`
  });
  const nOk = !cfg.useIndexFilter || idxState === 'unknown' ? null : idxState === (long ? 'up' : 'down');
  checks.push({
    key: 'nifty', label: 'Nifty agrees', ok: nOk,
    actual: idxState === 'unknown' ? 'unknown' : `Nifty ${idxState === 'up' ? 'above' : 'below'} its VWAP`, required: `Nifty ${long ? 'above' : 'below'} its VWAP`,
    why: !cfg.useIndexFilter ? 'The Nifty filter is switched off.' : nOk == null ? 'Nifty data is not available yet.' : nOk ? `Nifty is ${long ? 'above' : 'below'} its VWAP, so the market supports a ${side}.` : `Nifty is ${idxState === 'up' ? 'above' : 'below'} its VWAP, which is against a ${side}.`
  });
  const cOk = brk ? chasePct <= cfg.maxChasePct : null;
  checks.push({
    key: 'chase', label: 'Not chasing', ok: cOk,
    actual: brk ? `${chasePct.toFixed(2)}% past the trigger` : 'no breakout yet', required: `at most ${cfg.maxChasePct}% past the trigger`,
    why: cOk == null ? 'No breakout yet, so there is nothing to chase.' : cOk ? `Price is only ${chasePct.toFixed(2)}% past the trigger, so the entry price is still good.` : `Price already ran ${chasePct.toFixed(2)}% past the trigger (limit ${cfg.maxChasePct}%), so entering now would pay a poor price.`
  });
  const room = positions < p.maxPositions && trades < cfg.maxTradesPerDay;
  checks.push({
    key: 'room', label: 'Room to trade', ok: room,
    actual: `${positions}/${p.maxPositions} open, ${trades}/${cfg.maxTradesPerDay} trades today`, required: 'below the position and daily trade limits',
    why: room ? 'The position and daily trade limits are not reached.' : 'The position or daily trade limit is reached.'
  });
  return checks;
}

const allPass = checks => checks.every(c => c.ok !== false);
const failed = checks => checks.filter(c => c.ok === false).map(c => c.label);

module.exports = { buildChecks, allPass, failed };
