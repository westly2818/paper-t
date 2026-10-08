const test = require('node:test');
const assert = require('node:assert');
const V = require('../lib/validate');
const { judge, GATE } = require('../lib/decide');

const r = V.rng(99);
const gauss = () => { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
// n trades over `days` days, true average excess `mu`; days cycle up / down / flat
const make = (n, days, mu) => Array.from({ length: n }, (_, i) => {
  const d = i % days, ex = mu + gauss() * 0.8;
  return { day: 'd' + String(d).padStart(3, '0'), kind: ['up', 'down', 'flat'][d % 3], excess: ex, bench: 0.1, r: 0.1 + ex, net: (0.1 + ex) * 50 };
});

test('a small sample is "too early" whatever the numbers say', () => {
  const j = judge(make(4, 2, 1.5));
  assert.strictEqual(j.gateOk, false);
  assert.ok(j.missing.some(m => /trades/.test(m)) && j.missing.some(m => /days/.test(m)));
  assert.ok(j.confidence > 0.5);     // it may look great, the gate is what stops anyone acting on it
});

test('with no true edge the confidence is spread out, so a high reading by chance is common but not the norm', () => {
  const c = [];
  for (let s = 0; s < 60; s++) c.push(judge(make(120, 40, 0), undefined, { n: 400, seed: s + 1 }).confidence);
  const mean = c.reduce((x, y) => x + y, 0) / c.length, share90 = c.filter(v => v >= 0.9).length / c.length;
  assert.ok(mean > 0.3 && mean < 0.7, 'mean confidence ' + mean);
  assert.ok(share90 < 0.3, 'share at 90%+ ' + share90);
});

test('a real edge with a big, varied sample is recognised', () => {
  const j = judge(make(240, 60, 0.4));
  assert.strictEqual(j.gateOk, true);
  assert.ok(j.confidence > 0.95); assert.match(j.band, /STRONG/);
});

test('a real negative edge is "leaning no"', () => {
  const j = judge(make(240, 60, -0.4));
  assert.match(j.band, /LEANING NO/);
});

test('the gate also needs both kinds of day', () => {
  const rows = make(120, 40, 0.3).map(x => ({ ...x, kind: 'down' }));   // 40 days, every one a down day
  const j = judge(rows);
  assert.strictEqual(j.gateOk, false);
  assert.ok(j.missing.some(m => /up days/.test(m)));
});

test('bands follow the confidence in the documented order', () => {
  const { BANDS } = require('../lib/decide');
  assert.deepStrictEqual(BANDS.map(b => b[0]), [0.9, 0.75, 0.6, 0.4, 0]);
  assert.deepStrictEqual(GATE, { trades: 30, days: 15, up: 4, down: 4 });
});
