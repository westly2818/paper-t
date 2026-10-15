const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { MlShadowView, health, inMarketHours } = require('../lib/mlshadow');

const mem = (kv, lists) => ({ cfg: {}, key: k => k, get: async k => kv[k] ?? null, list: async k => lists[k] || [] });
const IST = 5.5 * 3600e3;
const at = (day, hhmm) => { const [h, m] = hhmm.split(':').map(Number); return Date.parse(day + 'T00:00:00Z') - IST + (h * 60 + m) * 60000; };   // IST wall time -> epoch ms
const MON = '2026-10-12', SAT = '2026-10-17';

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

test('market hours: weekdays 09:15 to 15:40 IST only', () => {
  assert.ok(inMarketHours(at(MON, '09:15')) && inMarketHours(at(MON, '15:40')));
  assert.ok(!inMarketHours(at(MON, '09:14')) && !inMarketHours(at(MON, '15:41')) && !inMarketHours(at(SAT, '11:00')));
});

test('health: every state is explicit and a missing heartbeat is never shown as fine', () => {
  const st = (state, hhmm, extra = {}) => ({ state, at: MON + 'T' + hhmm + ':00', detail: 'd', ...extra });
  const now = at(MON, '11:32');
  assert.strictEqual(health(null, now).state, 'never_started');
  assert.strictEqual(health(null, at(SAT, '11:00')).state, 'idle');
  assert.deepStrictEqual([health(st('running', '11:30'), now).state, health(st('running', '11:30'), now).severity], ['running', 'ok']);
  assert.strictEqual(health(st('stale_data', '11:30'), now).severity, 'warn');
  assert.strictEqual(health(st('auth_failed', '11:30'), now).label, 'Authentication failed');
  assert.strictEqual(health(st('feed_error', '11:30'), now).severity, 'bad');
  assert.strictEqual(health(st('error', '11:30'), now).state, 'error');
  const dead = health(st('running', '11:00'), now);                       // reported "running" 32 minutes ago: the service has stopped
  assert.strictEqual(dead.state, 'not_running'); assert.strictEqual(dead.severity, 'bad'); assert.match(dead.detail, /32 minutes/);
  const closed = health(st('running', '15:35'), at(MON, '18:00'));        // after hours the page says market closed, with the last state
  assert.strictEqual(closed.state, 'market_closed'); assert.match(closed.detail, /running/);
  assert.strictEqual(health(st('market_closed', '11:30'), now).severity, 'warn');   // service thinks it is closed while it is market time
});

test('snapshot carries the health even when there are no predictions yet', async () => {
  const v = new MlShadowView({}, { store: mem({ status: { state: 'auth_failed', at: MON + 'T09:20:20', detail: 'Fyers token missing' } }, {}), now: () => at(MON, '09:24') });
  const s = await v.snapshot();
  assert.strictEqual(s.empty, true); assert.strictEqual(s.health.state, 'auth_failed');
});
