// The Entry watch confidence score: a transparent checklist, never a trading rule.
const test = require('node:test');
const assert = require('node:assert');
const { buildConfidence, compact, WEIGHTS } = require('../lib/confidence');

const best = { dir: 1, planBias: 'bull', price: 101, vwap: 100, volRatio: 1.4, minVol: 0.9, niftyAgrees: true, relStrength: 1.2, prevDayBreak: true, newsOn: true, newsVerdict: true, riskMult: 1 };

test('weights add up to 100 and a perfect long scores 100 (High)', () => {
  assert.strictEqual(Object.values(WEIGHTS).reduce((a, b) => a + b, 0), 100);
  const c = buildConfidence(best);
  assert.strictEqual(c.score, 100);
  assert.strictEqual(c.label, 'High');
  assert.strictEqual(c.parts.length, 8);
});

test('a perfect short scores 100 too (direction is mirrored)', () => {
  const c = buildConfidence({ ...best, dir: -1, planBias: 'bear', price: 99, vwap: 100 });
  assert.strictEqual(c.score, 100);
});

test('everything against the trade scores low', () => {
  const c = buildConfidence({ dir: 1, planBias: 'bear', price: 99, vwap: 100, volRatio: 0.3, minVol: 0.9, niftyAgrees: false, relStrength: -1, prevDayBreak: false, newsOn: true, newsVerdict: false, riskMult: 0.5 });
  assert.strictEqual(c.score, 0);
  assert.strictEqual(c.label, 'Low');
});

test('partial credit: neutral trend, small relative strength, volume at the minimum, news off', () => {
  const c = buildConfidence({ ...best, planBias: 'neutral', relStrength: 0.3, volRatio: 0.9, newsOn: false });
  const pts = Object.fromEntries(c.parts.map(p => [p.key, p.points]));
  assert.strictEqual(pts.trend, 8);          // 40% of 20
  assert.strictEqual(pts.relStrength, 11);   // positive but under 0.5: 55% of 20
  assert.strictEqual(pts.volume, 15);        // inside the healthy range, 0.9x up to 2x
  assert.strictEqual(pts.news, 5);           // news check off: half
  assert.strictEqual(c.score, 8 + 11 + 15 + 15 + 10 + 5 + 5 + 5);
  assert.strictEqual(c.label, 'Medium');
});

test('very high volume (2x or more) earns no credit, as it did worse in past replays', () => {
  const pts = r => buildConfidence({ ...best, volRatio: r }).parts.find(p => p.key === 'volume').points;
  assert.strictEqual(pts(1.99), 15);
  assert.strictEqual(pts(2.0), 0);
  assert.strictEqual(pts(3.5), 0);
  assert.strictEqual(pts(0.5), 0);
});

test('unknown inputs never crash and never give free credit', () => {
  const c = buildConfidence({ dir: 1, planBias: 'bull', price: 101, vwap: 100, volRatio: null, minVol: 0.9, niftyAgrees: null, relStrength: null, prevDayBreak: null, newsOn: true, newsVerdict: null, riskMult: null });
  const pts = Object.fromEntries(c.parts.map(p => [p.key, p.points]));
  assert.strictEqual(pts.volume, 0);
  assert.strictEqual(pts.relStrength, 0);
  assert.strictEqual(pts.prevDay, 0);
  assert.strictEqual(pts.news, 0, 'an unverified stock gets no news credit');
  assert.strictEqual(pts.nifty, Math.round(WEIGHTS.nifty * 0.5));
});

test('the stored form is small and keeps every part', () => {
  const s = compact(buildConfidence(best));
  assert.deepStrictEqual(Object.keys(s), ['score', 'label', 'parts']);
  assert.strictEqual(s.parts.length, 8);
  assert.ok(s.parts.every(p => 'k' in p && 'p' in p && 'm' in p));
  assert.ok(JSON.stringify(s).length < 400);
});
