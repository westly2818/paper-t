const test = require('node:test');
const assert = require('node:assert');
const V = require('../lib/validate');

// deterministic noise so the tests never flake
const r = V.rng(123);
const gauss = () => { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
const make = (n, mu, perDay = 1) => { const v = [], d = []; for (let i = 0; i < n; i++) { v.push(mu + gauss()); d.push('d' + Math.floor(i / perDay)); } return { v, d }; };

test('no edge: the average is not proven above zero', () => {
  const { v, d } = make(300, 0);
  const bs = V.clusterBootstrap(v, d), sf = V.signFlipTest(v, d);
  assert.ok(bs.meanLo < 0 && bs.meanHi > 0, 'range should straddle zero');
  assert.ok(sf.p > 0.05, 'p = ' + sf.p);
});

test('a real edge is detected', () => {
  const { v, d } = make(300, 0.4);
  const bs = V.clusterBootstrap(v, d), sf = V.signFlipTest(v, d);
  assert.ok(bs.meanLo > 0);
  assert.ok(sf.p < 0.01, 'p = ' + sf.p);
  assert.ok(bs.probMeanAboveZero > 0.99);
});

test('trades that move together on a day give a wider range than treating them as independent', () => {
  const g = Array.from({ length: 20 }, () => gauss()), v = [], d = [];
  g.forEach((x, i) => { for (let k = 0; k < 10; k++) { v.push(x); d.push('d' + i); } }); // ten identical trades per day
  const bs = V.clusterBootstrap(v, d);
  const naive = 2 * 1.96 * V.sd(v) / Math.sqrt(v.length);
  assert.ok(bs.meanHi - bs.meanLo > 2.5 * naive, `cluster ${bs.meanHi - bs.meanLo} vs naive ${naive}`);
});

test('walk-forward counts positive slices and the chance of that by luck', () => {
  const wf = V.walkForward([1, 1, 1, 1, 1, 1, 1, 1], 4);
  assert.strictEqual(wf.positive, 4);
  assert.ok(Math.abs(wf.pAllThisGood - 1 / 16) < 1e-12);
  const mixed = V.walkForward([1, 1, -1, -1, 1, 1, -1, -1], 4);
  assert.strictEqual(mixed.positive, 2);
});

test('drawdown shuffle: a list of only wins never has a drawdown', () => {
  const dd = V.drawdownShuffle([1, 2, 3, 4, 5, 6], { n: 200 });
  assert.strictEqual(dd.observed, 0);
  assert.strictEqual(dd.shareAsBad, 1);
});

test('same seed, same answer', () => {
  const { v, d } = make(120, 0.1);
  assert.deepStrictEqual(V.clusterBootstrap(v, d), V.clusterBootstrap(v, d));
  assert.deepStrictEqual(V.signFlipTest(v, d), V.signFlipTest(v, d));
});

test('multiple-testing adjustment', () => {
  assert.ok(Math.abs(V.sidak(0.05, 1) - 0.05) < 1e-12);
  assert.ok(Math.abs(V.sidak(0.01, 5) - (1 - 0.99 ** 5)) < 1e-12);
  assert.strictEqual(V.sidak(1, 10), 1);
});
