// Every setting that can be changed from the app's Settings screen. Values are saved in Redis (or
// data/settings.json locally) as overrides of the defaults in config.js, so no environment
// variables and no redeploy are needed. Only the Upstash connection values and MODE stay in the
// environment, because the app needs them before it can read any saved setting.
// type: number | bool | time (HH:MM IST, stored as minutes) | text
const SCHEMA = [
  { key: 'capital', group: 'Capital and risk', label: 'Starting capital', type: 'number', min: 1000, max: 10000000, step: 1000, unit: 'INR', help: 'Virtual cash. A change is treated like a deposit or withdrawal, so today\'s P&L and the loss limit are not disturbed.' },
  { key: 'leverage', group: 'Capital and risk', label: 'Leverage', type: 'number', min: 1, max: 10, step: 0.5, unit: 'x', help: 'Buying power = capital x leverage. 1 = cash only. Indian brokers give about 5x intraday on many stocks.' },
  { key: 'riskPct', group: 'Capital and risk', label: 'Risk per trade', type: 'number', min: 0.1, max: 3, step: 0.1, unit: '% of equity', help: 'Maximum loss if the stop is hit (stop distance x quantity). The max-in-one-stock cap can make it smaller.' },
  { key: 'maxAllocPct', group: 'Capital and risk', label: 'Max in one stock', type: 'number', min: 5, max: 100, step: 5, unit: '% of buying power', help: 'Caps the position size. This is what limits quantity on cheap-stop trades.' },
  { key: 'maxPositions', group: 'Capital and risk', label: 'Max open positions', type: 'number', min: 1, max: 10, step: 1, help: 'Open at the same time.' },
  { key: 'maxTradesPerDay', group: 'Capital and risk', label: 'Max trades per day', type: 'number', min: 1, max: 30, step: 1 },
  { key: 'dailyLossPct', group: 'Capital and risk', label: 'Daily loss limit', type: 'number', min: 0.5, max: 10, step: 0.5, unit: '% of capital', help: 'Everything closes and no new trades are taken for the day.' },

  { key: 'lastEntryMin', group: 'Entry rules', label: 'Last entry time', type: 'time', min: '09:30', max: '15:00', unit: 'IST', help: 'No new trades after this time (a 5-minute candle must close by it). Version 3.1: 10:30 (version 3 was 10:00).' },
  { key: 'orMinutes', group: 'Entry rules', label: 'Opening range length', type: 'number', min: 5, max: 30, step: 5, unit: 'minutes', help: 'Range is built from the first N minutes after 9:15. Applies to plans built from the next morning.' },
  { key: 'triggerBufferPct', group: 'Entry rules', label: 'Trigger buffer', type: 'number', min: 0, max: 0.3, step: 0.01, unit: '%', help: 'Entry level sits this far beyond the range edge.' },
  { key: 'minOrPct', group: 'Entry rules', label: 'Min range size', type: 'number', min: 0.1, max: 2, step: 0.05, unit: '%', help: 'Skip the stock if the opening range is tighter than this.' },
  { key: 'maxOrPct', group: 'Entry rules', label: 'Max range size', type: 'number', min: 0.5, max: 6, step: 0.1, unit: '%', help: 'Skip the stock if the opening range is wider than this.' },
  { key: 'minVolRatio', group: 'Entry rules', label: 'Min breakout volume', type: 'number', min: 0, max: 5, step: 0.05, unit: 'x average', help: 'Breakout candle volume vs the average of all of today\'s closed 5-minute candles so far, including the opening-range candles and the breakout candle itself.' },
  { key: 'maxChasePct', group: 'Entry rules', label: 'Max chase', type: 'number', min: 0.1, max: 2, step: 0.05, unit: '%', help: 'Do not enter if price is already this far past the trigger.' },
  { key: 'useIndexFilter', group: 'Entry rules', label: 'Nifty must agree', type: 'bool', help: 'Long needs Nifty above its VWAP, short needs it below.' },
  { key: 'allowShort', group: 'Entry rules', label: 'Allow short trades', type: 'bool' },

  { key: 'rr', group: 'Exit rules', label: 'Target (reward : risk)', type: 'number', min: 1, max: 5, step: 0.25, unit: 'R', help: 'Target = this many times the stop distance.' },
  { key: 'breakevenR', group: 'Exit rules', label: 'Move stop to breakeven at', type: 'number', min: 0.25, max: 2, step: 0.05, unit: 'R profit' },
  { key: 'trailing', group: 'Exit rules', label: 'Trailing stop', type: 'bool', help: 'At +1.5R the stop trails 1R behind the best price (the 2R target stays active).' },
  { key: 'squareOffMin', group: 'Exit rules', label: 'Close everything at', type: 'time', min: '14:00', max: '15:25', unit: 'IST' },
  { key: 'minStopPct', group: 'Exit rules', label: 'Min stop distance', type: 'number', min: 0.1, max: 2, step: 0.05, unit: '%' },
  { key: 'maxStopPct', group: 'Exit rules', label: 'Max stop distance', type: 'number', min: 0.3, max: 4, step: 0.05, unit: '%' },
  { key: 'slippagePct', group: 'Exit rules', label: 'Slippage', type: 'number', min: 0, max: 0.2, step: 0.01, unit: '%', help: 'Assumed on every fill.' },

  { key: 'shortlistSize', group: 'Stock selection', label: 'Stocks watched', type: 'number', min: 1, max: 30, step: 1, help: 'Takes effect at the next morning plan. With the balanced list on, half are long candidates and half short candidates.' },
  { key: 'balancedShortlist', group: 'Stock selection', label: 'Balanced long and short list', type: 'bool', help: 'Watch the best uptrend stocks for long entries as well as the best downtrend stocks for short entries, so a falling market still shows long setups. Next morning plan.' },
  { key: 'backupPoolSize', group: 'Stock selection', label: 'Backup stocks', type: 'number', min: 0, max: 40, step: 1, help: 'Takes effect at the next morning plan.' },
  { key: 'minAtrPct', group: 'Stock selection', label: 'Min daily movement (ATR)', type: 'number', min: 0.3, max: 5, step: 0.1, unit: '%', help: 'Next morning plan.' },
  { key: 'maxAtrPct', group: 'Stock selection', label: 'Max daily movement (ATR)', type: 'number', min: 1, max: 10, step: 0.1, unit: '%', help: 'Next morning plan.' },
  { key: 'minTurnover', group: 'Stock selection', label: 'Min average turnover', type: 'number', min: 0, max: 5e10, step: 1e7, unit: 'INR per day', help: 'Liquidity filter. Next morning plan.' },
  { key: 'replaceUntilMin', group: 'Stock selection', label: 'Replace dead slots until', type: 'time', min: '09:30', max: '15:00', unit: 'IST', help: 'After this time a dead slot stays empty.' },
  { key: 'replaceCandidates', group: 'Stock selection', label: 'Backups checked per dead slot', type: 'number', min: 1, max: 6, step: 1 },

  { key: 'newsGuard', group: 'News and market risk', label: 'Manual news check', type: 'bool', help: 'Paste a ChatGPT reply each morning. Takes effect from the next morning plan.' },
  { key: 'newsAuto', group: 'News and market risk', label: 'Automatic news check (Gemini)', type: 'bool', help: 'Fetches recent headlines and has Gemini classify them. Needs the Gemini key in the environment. If it fails, the manual paste box appears and stocks are never assumed safe.' },
  { key: 'unverifiedPolicy', group: 'News and market risk', label: 'Stock the check could not verify', type: 'select', options: [{ v: 'block', label: 'Do not trade it (recommended)' }, { v: 'allow', label: 'Trade it anyway' }], help: 'Applies when news is missing, the search failed, or the reply left a stock out. An unknown market level also cuts risk to 75% when stocks are not traded.' },
  { key: 'newsWindowHours', group: 'News and market risk', label: 'News window', type: 'number', min: 6, max: 72, step: 6, unit: 'hours', help: 'Only headlines published within this window are used.' },
  { key: 'geminiModel', group: 'News and market risk', label: 'Gemini model', type: 'text', max: 40, help: 'Backups are tried automatically if this one is unavailable.' },
  { key: 'newsRequired', group: 'News and market risk', label: 'News check is required', type: 'bool', help: 'Hides the skip button; trading waits for the paste.' },
  { key: 'vixElevated', group: 'News and market risk', label: 'India VIX "elevated" from', type: 'number', min: 10, max: 40, step: 1, help: 'Risk is cut to 75%.' },
  { key: 'elevatedMarketCutsRisk', group: 'News and market risk', label: 'Cut size when the news check says "elevated"', type: 'bool', help: 'Off since version 3.3: in a 126-session test the "elevated" call (83% of days) did not mark more volatile days. "High" always cuts to 50% with 2 positions.' },
  { key: 'vixHigh', group: 'News and market risk', label: 'India VIX "very high" from', type: 'number', min: 12, max: 60, step: 1, help: 'Risk is cut to 50%.' },

  { key: 'strategyVersion', group: 'Labels', label: 'Strategy version label', type: 'text', max: 20, help: 'Saved with every trade so results can be compared per rule set. Change it whenever you change a rule.' }
];

const BY_KEY = Object.fromEntries(SCHEMA.map(s => [s.key, s]));
const pad = n => String(n).padStart(2, '0');
const minToText = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const textToMin = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t).trim()); if (!m || +m[1] > 23 || +m[2] > 59) throw new Error('use HH:MM'); return +m[1] * 60 + +m[2]; };

const toDisplay = (f, v) => (f.type === 'time' ? minToText(v) : v);

// One field from the screen -> internal value. Throws a readable message.
function fromInput(f, raw) {
  if (f.type === 'bool') { if (typeof raw !== 'boolean') throw new Error('must be on or off'); return raw; }
  if (f.type === 'text') { const s = String(raw).trim(); if (!s || s.length > f.max) throw new Error(`1 to ${f.max} characters`); return s; }
  if (f.type === 'select') { if (!f.options.some(o => o.v === raw)) throw new Error('pick one of the options'); return raw; }
  if (f.type === 'time') {
    const m = textToMin(raw);
    if (m < textToMin(f.min) || m > textToMin(f.max)) throw new Error(`between ${f.min} and ${f.max}`);
    return m;
  }
  const n = +raw;
  if (raw === '' || raw === null || !isFinite(n)) throw new Error('must be a number');
  if (n < f.min || n > f.max) throw new Error(`between ${f.min} and ${f.max}`);
  return n;
}

// Checks that go across fields. next = full set of internal values.
function crossCheck(next) {
  if (next.lastEntryMin >= next.squareOffMin) throw new Error('Last entry time must be before the close-everything time');
  if (next.lastEntryMin < 9 * 60 + 15 + next.orMinutes + 5) throw new Error('Last entry time must be at least 5 minutes after the opening range ends');
  if (next.minOrPct >= next.maxOrPct) throw new Error('Min range size must be below max range size');
  if (next.minStopPct >= next.maxStopPct) throw new Error('Min stop distance must be below max stop distance');
  if (next.minAtrPct >= next.maxAtrPct) throw new Error('Min ATR must be below max ATR');
  if (next.vixElevated >= next.vixHigh) throw new Error('VIX "elevated" must be below VIX "very high"');
}

// patch = { key: rawValueFromScreen }. Returns { clean, errors }.
function validatePatch(patch) {
  const clean = {}, errors = {};
  for (const [k, raw] of Object.entries(patch || {})) {
    const f = BY_KEY[k];
    if (!f) { errors[k] = 'unknown setting'; continue; }
    try { clean[k] = fromInput(f, raw); } catch (e) { errors[k] = e.message; }
  }
  return { clean, errors };
}

const captureDefaults = cfg => Object.fromEntries(SCHEMA.map(f => [f.key, cfg[f.key]]));
const snapshot = cfg => captureDefaults(cfg);

module.exports = { SCHEMA, BY_KEY, toDisplay, fromInput, validatePatch, crossCheck, captureDefaults, snapshot, minToText };
