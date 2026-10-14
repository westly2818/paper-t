const test = require('node:test');
const assert = require('node:assert');
const { price, impliedVol } = require('../lib/bs');
const near = (a, b, e) => Math.abs(a - b) < e;

test('textbook value: S=100, K=100, T=1, vol 20%, r 5% -> call 10.4506, put 5.5735', () => {
  assert.ok(near(price('CE', 100, 100, 1, 0.2, 0.05), 10.4506, 0.005));
  assert.ok(near(price('PE', 100, 100, 1, 0.2, 0.05), 5.5735, 0.005));
});
test('put-call parity', () => {
  const S = 22000, K = 22100, T = 0.03, s = 0.15, r = 0.065;
  assert.ok(near(price('CE', S, K, T, s, r) - price('PE', S, K, T, s, r), S - K * Math.exp(-r * T), 1e-6));
});
test('implied volatility inverts the price', () => {
  const p = price('PE', 22340, 22200, 0.02, 0.17, 0.065);
  assert.ok(near(impliedVol('PE', 22340, 22200, 0.02, p, 0.065), 0.17, 1e-6));
});
test('at expiry the price is the intrinsic value', () => {
  assert.strictEqual(price('CE', 100, 90, 0, 0.2), 10); assert.strictEqual(price('PE', 100, 90, 0, 0.2), 0);
});
