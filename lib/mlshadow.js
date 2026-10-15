// Read-only view of the ML shadow predictions written by the separate ml-trading service (python -m shadow.run_live).
// That service stores its records in this app's own Store format under the "shadow" namespace:
//   paper-trader:shadow:summary and :status (JSON), :decisions, :predictions, :outcomes (lists). Nothing here trades, and nothing here can: this file only reads.
const { Store } = require('./store');

const TAIL = { decisions: 40, predictions: 8, outcomes: 80 };
const IST_MS = 5.5 * 3600e3;
const MARKET_OPEN = 9 * 60 + 15, MARKET_END = 15 * 60 + 40;       // the service acts from the first candle until 15:40 IST
const HEARTBEAT_LIMIT_MIN = 12;                                      // the service reports every 5 minutes during market hours

function inMarketHours(ms) {
  const d = new Date(ms + IST_MS), dow = d.getUTCDay(), m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return dow >= 1 && dow <= 5 && m >= MARKET_OPEN && m <= MARKET_END;
}

// The one place that decides what the page says about the service. A silent failure would hollow out the forward record, so every state is explicit.
function health(status, nowMs) {
  const open = inMarketHours(nowMs);
  if (!status) return open ? { state: 'never_started', severity: 'bad', label: 'Service has never reported', detail: 'Start it: python -m shadow.run_live --env-file ../paper-trader/.env' }
    : { state: 'idle', severity: 'idle', label: 'Market closed', detail: 'No heartbeat has been received yet.' };
  const atMs = Date.parse(String(status.at).includes('+') || String(status.at).endsWith('Z') ? status.at : status.at + '+05:30');
  const ageMin = Number.isFinite(atMs) ? (nowMs - atMs) / 60000 : Infinity;
  const base = { ageMin: Math.round(ageMin * 10) / 10, lastState: status.state, lastDetail: status.detail || '', at: status.at };
  if (!open) return { ...base, state: 'market_closed', severity: 'idle', label: 'Market closed', detail: 'Last heartbeat ' + status.at.replace('T', ' ') + ' (' + status.state + ').' };
  if (!(ageMin <= HEARTBEAT_LIMIT_MIN)) return { ...base, state: 'not_running', severity: 'bad', label: 'Service not running', detail: 'No heartbeat for ' + (Number.isFinite(ageMin) ? Math.round(ageMin) : '?') + ' minutes. Decisions in this period are being missed.' };
  switch (status.state) {
    case 'running': return { ...base, state: 'running', severity: 'ok', label: 'Running', detail: status.detail || '' };
    case 'stale_data': return { ...base, state: 'stale_data', severity: 'warn', label: 'Stale data', detail: status.detail || 'Completed candles are not arriving.' };
    case 'auth_failed': return { ...base, state: 'auth_failed', severity: 'bad', label: 'Authentication failed', detail: status.detail || 'Press the Fyers button in this app.' };
    case 'feed_error': return { ...base, state: 'feed_error', severity: 'bad', label: 'Data feed error', detail: status.detail || '' };
    case 'market_closed': return { ...base, state: 'market_closed', severity: 'warn', label: 'Service says market closed', detail: 'It is market time here: check the service clock or whether today is a holiday.' };
    default: return { ...base, state: 'error', severity: 'bad', label: 'Service error', detail: status.detail || String(status.state) };
  }
}

class MlShadowView {
  constructor(cfg, opts = {}) { this.cfg = cfg; this.store = opts.store || new Store(cfg, 'shadow'); this.now = opts.now || (() => Date.now()); }

  async tail(kind, n) {
    const s = this.store;
    if (s.cfg && s.cfg.upstashUrl && typeof s.redis === 'function') return ((await s.redis(['LRANGE', s.key(kind), -n, -1])) || []).map(x => JSON.parse(x));
    return (await s.list(kind)).slice(-n);
  }

  async snapshot() {
    const [summary, status] = await Promise.all([this.store.get('summary'), this.store.get('status')]);
    const h = health(status, this.now());
    if (!summary) return { enabled: true, readOnly: true, empty: true, health: h, note: 'No shadow predictions yet. They appear once the ml-trading shadow service runs during market hours (python -m shadow.run_live).' };
    const [decisions, lastPreds, outcomes] = await Promise.all([this.tail('decisions', TAIL.decisions), this.tail('predictions', TAIL.predictions), this.tail('outcomes', TAIL.outcomes)]);
    const latestId = lastPreds.length ? lastPreds[lastPreds.length - 1].decision_id : null;
    return {
      enabled: true, readOnly: true, empty: false, summary, health: h,
      decisions: decisions.slice().reverse().slice(0, 12).map(d => ({ id: d.id, time: d.decision_time, status: d.status, reason: d.reason || null, predictions: d.predictions || 0, legs: d.legs || null })),
      latest: lastPreds.filter(p => p.decision_id === latestId).sort((a, b) => a.rank - b.rank).map(p => ({ symbol: p.symbol, rank: p.rank, prediction: p.prediction, leg: p.leg, time: p.decision_time })),
      outcomes: outcomes.filter(o => o.kind === 'prediction').slice(-24).reverse().map(o => ({ day: o.day, slot: o.slot, symbol: o.symbol, prediction: o.prediction, y: o.y, y_cs: o.y_cs, leg: o.leg || null, net_bps_conservative: o.net_bps_conservative == null ? null : o.net_bps_conservative })),
    };
  }
}

module.exports = { MlShadowView, health, inMarketHours };
