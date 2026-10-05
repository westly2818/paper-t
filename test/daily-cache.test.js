// The daily price history behind the morning ranking must be fetched again each new day in live mode.
const test = require('node:test');
const assert = require('node:assert');
const { YahooProvider } = require('../lib/data');

const IST = 5.5 * 3600e3;
const bar = (y, m, d) => ({ t: Date.UTC(y, m - 1, d, 3, 45), o: 100, h: 101, l: 99, c: 100 + d, v: 1000 });
const dayOf = ms => new Date(ms + IST).toISOString().slice(0, 10);

function make(mode) {
  const p = new YahooProvider({ now: () => 0 }, { mode });
  let today = '2026-10-01', calls = 0;
  const published = [bar(2026, 9, 29), bar(2026, 9, 30)]; // what Yahoo has published so far
  p.today = () => today;
  p.yfDaily = async () => { calls++; return published.slice(); };
  return { p, publish: b => published.push(b), setToday: d => { today = d; }, calls: () => calls };
}

test('live: a new day refetches, so the ranking sees yesterday\'s finished bar', async () => {
  const { p, publish, setToday, calls } = make('live');
  let bars = await p.daily('X', '2026-10-01');
  assert.strictEqual(dayOf(bars[bars.length - 1].t), '2026-09-30');
  await p.daily('X', '2026-10-01');
  assert.strictEqual(calls(), 1, 'the same day uses the cache');
  publish(bar(2026, 10, 1));            // 1 Oct finishes and Yahoo publishes it
  setToday('2026-10-02');
  bars = await p.daily('X', '2026-10-02');
  assert.strictEqual(calls(), 2, 'a new day fetches again');
  assert.strictEqual(dayOf(bars[bars.length - 1].t), '2026-10-01', 'the newest bar before the plan day is used (it was one session old before the fix)');
});

test('replay and backtests keep the cache', async () => {
  const { p, publish, setToday, calls } = make('replay');
  await p.daily('X', '2026-10-01');
  publish(bar(2026, 10, 1)); setToday('2026-10-02');
  await p.daily('X', '2026-10-02');
  assert.strictEqual(calls(), 1);
});

test('bars on or after the plan day are never used', async () => {
  const { p, publish } = make('live');
  publish(bar(2026, 10, 1)); publish(bar(2026, 10, 2));
  const bars = await p.daily('X', '2026-10-02');
  assert.strictEqual(dayOf(bars[bars.length - 1].t), '2026-10-01');
});
