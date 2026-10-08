const test = require('node:test');
const assert = require('node:assert');
const F = require('../lib/factors');
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;

test('csRank: percentile rank across stocks on each date, ties share the average', () => {
  const m = [[10, 5], [20, 5], [30, 7]]; // 3 stocks, 2 dates
  const r = F.csRank(m);
  assert.deepStrictEqual(r.map(row => row[0]), [1 / 3, 2 / 3, 1]);
  assert.ok(near(r[0][1], 1.5 / 3) && near(r[1][1], 1.5 / 3) && near(r[2][1], 1)); // tie of two lowest
});

test('csRank ignores missing values', () => {
  const r = F.csRank([[1], [NaN], [3]]);
  assert.strictEqual(r[0][0], 0.5); assert.strictEqual(r[2][0], 1); assert.ok(Number.isNaN(r[1][0]));
});

test('tsCorr: perfect and opposite relations, and the warm-up window', () => {
  const a = [[1, 2, 3, 4, 5, 6]], up = [[2, 4, 6, 8, 10, 12]], down = [[6, 5, 4, 3, 2, 1]];
  const c = F.tsCorr(a, up, 4), d = F.tsCorr(a, down, 4);
  assert.ok(Number.isNaN(c[0][2]));
  assert.ok(near(c[0][3], 1) && near(c[0][5], 1) && near(d[0][5], -1));
});

test('spearman: monotonic = 1, reversed = -1, nan pairs dropped', () => {
  const x = Array.from({ length: 20 }, (_, i) => i), y = x.map(v => v * v);
  assert.ok(near(F.spearman(x, y), 1));
  assert.ok(near(F.spearman(x, y.map(v => -v)), -1));
  assert.ok(near(F.spearman([...x, NaN], [...y, 5]), 1));
});

test('formulas match hand calculations', () => {
  const P = { open: [[10, 10]], close: [[11, 9]], high: [[12, 12]], low: [[9, 8]], volume: [[100, 200]] };
  assert.ok(near(F.FACTORS.A101.f(P)[0][0], (11 - 10) / (12 - 9 + 0.001)));
  // A12: volume rose (sign +1) and close fell by 2 => +1 * -(-2) = +2
  assert.strictEqual(F.FACTORS.A12.f(P)[0][1], 2);
  // A33 on a single stock: rank is 1, regardless of value
  assert.strictEqual(F.FACTORS.A33.f(P)[0][0], 1);
});

test('control factor is random and repeatable', () => {
  const P = { close: [[1, 2, 3], [1, 2, 3]] };
  const a = F.FACTORS.RANDOM.f(P), b = F.FACTORS.RANDOM.f(P);
  assert.deepStrictEqual(a, b);
  assert.ok(a[0][0] !== a[0][1]);
});
