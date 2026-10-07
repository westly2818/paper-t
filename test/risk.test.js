// Size rules: India VIX tiers, and Gemini's market call (version 3.3: "elevated" no longer cuts size).
const test = require('node:test');
const assert = require('node:assert');
const base = require('../config');
const { Engine } = require('../lib/engine');

const mk = over => new Engine({ ...base, mode: 'demo', ...over }, {}, { now: () => 0 });

test('version 3.3: an elevated market call does not cut size', () => {
  const r = mk({}).riskFrom(14, 'elevated');
  assert.strictEqual(r.mult, 1);
  assert.strictEqual(r.maxPositions, base.maxPositions);
});

test('a high market call still cuts to 50% with 2 positions', () => {
  const r = mk({}).riskFrom(14, 'high');
  assert.strictEqual(r.mult, 0.5);
  assert.strictEqual(r.maxPositions, 2);
});

test('an unverified market call still cuts to 75% (fail closed)', () => {
  assert.strictEqual(mk({}).riskFrom(14, 'unverified').mult, 0.75);
});

test('the old behaviour comes back with the setting on', () => {
  assert.strictEqual(mk({ elevatedMarketCutsRisk: true }).riskFrom(14, 'elevated').mult, 0.75);
});

test('India VIX rule is unchanged and the smaller size always wins', () => {
  const e = mk({});
  assert.strictEqual(e.riskFrom(18, null).mult, 0.75);
  assert.strictEqual(e.riskFrom(24, null).mult, 0.5);
  assert.strictEqual(e.riskFrom(18, 'high').mult, 0.5);
  assert.strictEqual(e.riskFrom(25, 'elevated').mult, 0.5);
});

test('applying a news result: unknown market level is treated as unverified, elevated as no cut', () => {
  const eng = mk({ newsGuard: true });
  const S = eng.S;
  S.day = '2026-01-05'; S.now = Date.UTC(2026, 0, 5, 3, 46);
  S.watch = { picked: [{ sym: 'AAA', bias: 'bull', close: 100 }], backups: [], pool: [], news: {} };
  eng.applyNews({ stocks: { AAA: { block: false, reason: 'ok', sources: [] } }, market: 'elevated', source: 'test' });
  assert.strictEqual(S.risk.mult, 1);
  S.watch.news = {};
  eng.applyNews({ stocks: { AAA: { block: false, reason: 'ok', sources: [] } }, market: 'unknown', source: 'test' });
  assert.strictEqual(S.risk.mult, 0.75);
  assert.strictEqual(S.watch.news.marketEffective, 'unverified');
});
