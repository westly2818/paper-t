const test = require('node:test');
const assert = require('node:assert');
const { breakoutFeatures } = require('../lib/indicators');
const { atMinute, OPEN } = require('../lib/time');

const DAY = '2026-01-05';
const bar = (k, c) => ({ t: atMinute(DAY, OPEN + k * 5), o: c, h: c + 0.2, l: c - 0.2, c, v: 1000 });
const minutes = n => Array.from({ length: n }, (_, i) => { const p = 100 + i * 0.01; return { t: atMinute(DAY, OPEN + i), o: p, h: p + 0.1, l: p - 0.1, c: p, v: 1000 }; });

test('fresh breakout: no earlier close beyond the trigger', () => {
  const done = [bar(0, 100), bar(1, 100.2), bar(2, 100.3), bar(3, 100.4), bar(4, 101.5)]; // 5th bar = 09:35, breaks 101
  const endT = done[4].t + 300000;
  const f = breakoutFeatures({ done, c1: minutes(40), endT, trigger: 101, dir: 1, orEndMin: OPEN + 15 });
  assert.strictEqual(f.crossedBefore, 0);
  assert.strictEqual(f.freshBreakout, true);
  assert.ok(Math.abs(f.priceSlope15m - ((101.5 - 100.2) / 100.2) * 100) < 1e-9);
  assert.ok(f.vwapSlope15m > 0);
});

test('late breakout: counts earlier closes beyond the trigger, in the trade direction only', () => {
  const done = [bar(0, 100), bar(1, 100.2), bar(2, 100.3), bar(3, 101.2), bar(4, 100.5), bar(5, 101.4)]; // closed beyond 101 at bar 3, now again at bar 5
  const endT = done[5].t + 300000;
  const long = breakoutFeatures({ done, c1: minutes(45), endT, trigger: 101, dir: 1, orEndMin: OPEN + 15 });
  assert.strictEqual(long.crossedBefore, 1);
  assert.strictEqual(long.freshBreakout, false);
  const short = breakoutFeatures({ done, c1: minutes(45), endT, trigger: 99, dir: -1, orEndMin: OPEN + 15 });
  assert.strictEqual(short.crossedBefore, 0); // nothing closed below 99
  assert.ok(short.priceSlope15m < 0);          // price rose, so the slope in a short's direction is negative
});

test('opening-range candles never count as earlier breakouts', () => {
  const done = [bar(0, 102), bar(1, 102), bar(2, 102), bar(3, 102.5)]; // all above 101 but the first three are the opening range
  const f = breakoutFeatures({ done, c1: minutes(25), endT: done[3].t + 300000, trigger: 101, dir: 1, orEndMin: OPEN + 15 });
  assert.strictEqual(f.crossedBefore, 0);
});
