// Read-only view of the ML shadow predictions written by the separate ml-trading service (python -m shadow.run_live).
// That service stores its records in this app's own Store format under the "shadow" namespace:
//   paper-trader:shadow:summary (JSON), :decisions, :predictions, :outcomes (lists). Nothing here trades, and nothing here can: this file only reads.
const { Store } = require('./store');

const TAIL = { decisions: 40, predictions: 8, outcomes: 80 };

class MlShadowView {
  constructor(cfg, opts = {}) { this.cfg = cfg; this.store = opts.store || new Store(cfg, 'shadow'); }

  async tail(kind, n) {
    const s = this.store;
    if (s.cfg && s.cfg.upstashUrl && typeof s.redis === 'function') return ((await s.redis(['LRANGE', s.key(kind), -n, -1])) || []).map(x => JSON.parse(x));
    return (await s.list(kind)).slice(-n);
  }

  async snapshot() {
    const summary = await this.store.get('summary');
    if (!summary) return { enabled: true, readOnly: true, empty: true, note: 'No shadow predictions yet. They appear once the ml-trading shadow service runs during market hours (python -m shadow.run_live).' };
    const [decisions, lastPreds, outcomes] = await Promise.all([this.tail('decisions', TAIL.decisions), this.tail('predictions', TAIL.predictions), this.tail('outcomes', TAIL.outcomes)]);
    const latestId = lastPreds.length ? lastPreds[lastPreds.length - 1].decision_id : null;
    return {
      enabled: true, readOnly: true, empty: false, summary,
      decisions: decisions.slice().reverse().slice(0, 12).map(d => ({ id: d.id, time: d.decision_time, status: d.status, reason: d.reason || null, predictions: d.predictions || 0, legs: d.legs || null })),
      latest: lastPreds.filter(p => p.decision_id === latestId).sort((a, b) => a.rank - b.rank).map(p => ({ symbol: p.symbol, rank: p.rank, prediction: p.prediction, leg: p.leg, time: p.decision_time })),
      outcomes: outcomes.filter(o => o.kind === 'prediction').slice(-24).reverse().map(o => ({ day: o.day, slot: o.slot, symbol: o.symbol, prediction: o.prediction, y: o.y, y_cs: o.y_cs, leg: o.leg || null, net_bps_conservative: o.net_bps_conservative == null ? null : o.net_bps_conservative })),
    };
  }
}

module.exports = { MlShadowView };
