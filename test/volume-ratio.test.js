// The live preview and the entry decision must show the same volume ratio for the same candles.
const test = require('node:test');
const assert = require('node:assert');
const base = require('../config');
const { Engine } = require('../lib/engine');
const { aggregate, volumeRatio } = require('../lib/indicators');
const { atMinute, OPEN } = require('../lib/time');

const DAY = '2026-01-05';
const mk = (sym, n, vol) => Array.from({ length: n }, (_, i) => {
  const p = 100 + i * 0.1;
  return { t: atMinute(DAY, OPEN + i), o: p, h: p + 0.2, l: p - 0.2, c: p + 0.1, v: vol(i) };
});

test('volumeRatio: last candle vs the average of all given candles, itself included', () => {
  assert.strictEqual(volumeRatio([]), null);
  assert.strictEqual(volumeRatio([{ v: 0 }, { v: 0 }]), 1);
  assert.strictEqual(volumeRatio([{ v: 100 }, { v: 100 }, { v: 100 }, { v: 60 }]), 60 / 90);
});

test('preview ratio equals the entry-decision ratio on the same candles', () => {
  const cfg = { ...base, mode: 'demo', newsGuard: false };
  const eng = new Engine(cfg, {}, { now: () => 0 });
  const S = eng.S;
  S.day = DAY; S.watch = { picked: [], news: {} }; S.risk = { mult: 1, maxPositions: 3 };
  // 30 one-minute candles (09:15 to 09:44) with uneven volume, so the 09:40 bar is the latest completed one
  const c1 = mk('X', 30, i => 1000 + (i % 7) * 300 + (i >= 25 ? 2500 : 0));
  S.candles['X'] = c1;
  S.candles[cfg.indexSymbol] = mk(cfg.indexSymbol, 30, () => 0);
  const bars = aggregate(c1, 5);
  const lastT = c1[c1.length - 1].t;
  const done = bars.filter(b => b.t + 300000 <= lastT + 60000);
  const b = done[done.length - 1];
  assert.strictEqual(b.t, bars[bars.length - 1].t, 'latest bar is complete, so preview and decision look at the same candle');
  const trigger = 1e9; // never breaks out, we only read the volume ratio
  const leg = { side: 'long', trigger, sl: trigger - 1, tp: trigger + 2, qty: 1, status: 'waiting', note: '' };
  S.plans['X'] = { sym: 'X', status: 'waiting', bias: 'neutral', legs: { long: leg }, or: { hi: 1, lo: 0, rangePct: 1 }, lastConsidered: 0 };
  const preview = eng.liveView().stocks.find(s => s.sym === 'X').legs.long.volRatio;
  eng.evaluate({ plan: S.plans['X'], c1, b, done, isLatest: true, lastT });
  const decision = eng._snap.volRatio;
  assert.ok(preview > 0 && Number.isFinite(preview));
  assert.strictEqual(preview, decision);
});
