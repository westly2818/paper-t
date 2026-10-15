const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { MlShadowView } = require('../lib/mlshadow');

const mem = (kv, lists) => ({ cfg: {}, key: k => k, get: async k => kv[k] ?? null, list: async k => lists[k] || [] });

test('empty store: a clear "nothing yet" answer, never an error', async () => {
  const v = new MlShadowView({}, { store: mem({}, {}) });
  const s = await v.snapshot();
  assert.strictEqual(s.empty, true); assert.strictEqual(s.readOnly, true); assert.match(s.note, /shadow\.run_live/);
});

test('snapshot: latest predictions ranked, recent decisions newest first, outcomes only of kind prediction', async () => {
  const preds = [];
  for (const [id, base] of [['20261012-12', 0], ['20261012-19', 1]]) for (const [i, sym] of ['SBIN', 'TCS', 'INFY'].entries()) preds.push({ decision_id: id, symbol: sym, rank: i + 1, prediction: base + i / 100, leg: i === 0 ? 'long' : null, decision_time: '2026-10-12T10:55:20' });
  const lists = {
    decisions: [{ id: '20261012-12', decision_time: 'a', status: 'predicted', predictions: 3 }, { id: '20261012-19', decision_time: 'b', status: 'skipped', reason: 'incomplete_or_unclean_data: SBIN=missing_open_candle' }],
    predictions: preds,
    outcomes: [{ kind: 'decision', decision_id: 'x' }, { kind: 'prediction', day: '2026-10-12', slot: 12, symbol: 'SBIN', prediction: 0.001, y: 0.002, y_cs: 0.001, leg: 'long', net_bps_conservative: -12.5 }],
  };
  const s = await new MlShadowView({}, { store: mem({ summary: { mode: 'SHADOW ONLY', decisions: 2 } }, lists) }).snapshot();
  assert.strictEqual(s.empty, false); assert.strictEqual(s.summary.decisions, 2);
  assert.deepStrictEqual(s.decisions.map(d => d.id), ['20261012-19', '20261012-12']);
  assert.strictEqual(s.decisions[0].reason, 'incomplete_or_unclean_data: SBIN=missing_open_candle');
  assert.deepStrictEqual(s.latest.map(p => p.symbol), ['SBIN', 'TCS', 'INFY']); assert.ok(s.latest.every(p => p.time));
  assert.strictEqual(s.outcomes.length, 1); assert.strictEqual(s.outcomes[0].net_bps_conservative, -12.5);
});

test('the view can only read: no write, trade or order functions exist in the module', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mlshadow.js'), 'utf8');
  assert.ok(!/\.(set|push)\(|RPUSH|\bSET\b|placeOrder|submitOrder|\/orders/.test(src.replace(/\/\/.*$/gm, '')));
});
