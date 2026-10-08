const test = require('node:test');
const assert = require('node:assert/strict');
const { preMarketScore, rankPremarket, liveScore } = require('../lib/v5-score');
const { V5Engine, charges } = require('../lib/v5-engine');
const { atMinute } = require('../lib/time');

test('v5: preMarketScore components and ranking', () => {
  const info1 = {
    sym: 'RELIANCE',
    close: 2500,
    turnover: 10e8,
    atrPct: 2.2,
    mom5: 3.5,
    bias: 'bull',
    rsi: 65,
    gapPct: 1.5,
    catalyst: { verified: true, explainsMove: true }
  };

  const scored1 = preMarketScore(info1);
  assert.ok(scored1.score >= 70, `Expected high score for strong candidate, got ${scored1.score}`);
  assert.equal(scored1.parts.catalyst, 20);

  const info2 = {
    sym: 'WEAK',
    close: 500,
    turnover: 1e8,
    atrPct: 0.5,
    mom5: -2.0,
    bias: 'neutral',
    rsi: 48,
    gapPct: 0.1
  };
  const scored2 = preMarketScore(info2);
  assert.ok(scored2.score < 50, `Expected low score for weak candidate, got ${scored2.score}`);

  const candidates = [info2, info1];
  const { picked, rest } = rankPremarket(candidates, null, 1);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].sym, 'RELIANCE');
  assert.equal(rest.length, 1);
  assert.equal(rest[0].sym, 'WEAK');
});

test('v5: liveScore produces 0-100 score and honors 70 threshold', () => {
  // Bullish aligned context
  const bullCtx = {
    c: 1005,
    vw: 1000,
    e9: 1003,
    e21: 998,
    rvol: 1.8,
    chg: 2.0,
    nchg: 0.5,
    nIntraChg: 0.4,
    rangePos: 0.95,
    dir: 1
  };
  const bullScore = liveScore(bullCtx);
  assert.ok(bullScore.score >= 70, `Expected score >= 70, got ${bullScore.score}`);
  assert.ok(bullScore.parts.relativeStrength > 20);
  assert.ok(bullScore.parts.trend > 15);
  assert.ok(bullScore.parts.vwap > 10);

  // Bearish or misaligned context for a long trade
  const bearCtx = {
    c: 990,
    vw: 1000,
    e9: 992,
    e21: 998,
    rvol: 0.5,
    chg: -1.5,
    nchg: 1.0,
    nIntraChg: -0.5,
    rangePos: 0.1,
    dir: 1
  };
  const bearScore = liveScore(bearCtx);
  assert.ok(bearScore.score < 40, `Expected score < 40, got ${bearScore.score}`);
});

test('v5: Setup A detects opening momentum breakout (09:30 - 10:30)', () => {
  const engine = new V5Engine({});
  const bars = [
    { t: 1000, o: 100, h: 102, l: 99, c: 101, v: 1000 },  // bar 0 (09:15)
    { t: 2000, o: 101, h: 103, l: 100, c: 102, v: 1200 }, // bar 1 (09:20)
    { t: 3000, o: 102, h: 103, l: 101, c: 102, v: 1100 }, // bar 2 (09:25) -> OR high = 103, low = 99, mid = 101
    { t: 4000, o: 102, h: 105, l: 102, c: 104.5, v: 2500 } // bar 3 (09:30) -> Breakout!
  ];

  const ctx = {
    bars,
    c: 104.5,
    vw: 102.0,
    e9: 103.0,
    e21: 101.5,
    rvol: 1.8
  };

  const sigLong = engine.checkSetupA(ctx, 1);
  assert.ok(sigLong, 'Should detect Setup A long');
  assert.equal(sigLong.setup, 'A');
  assert.equal(sigLong.dir, 1);
  assert.ok(sigLong.rawStop <= 102, 'Stop should be at or below breakout candle low / OR mid');
});

test('v5: Setup B detects pullback continuation (10:30 - 13:30)', () => {
  const engine = new V5Engine({});
  // Stock opened at 100, surged to 105 (impulse with 2000 vol), pulled back to 103 near 9 EMA (with 800 vol), then turned up to 104
  const bars = [
    { t: 1, o: 100, h: 102, l: 99, c: 101, v: 2000 },
    { t: 2, o: 101, h: 103, l: 100, c: 103, v: 2200 },
    { t: 3, o: 103, h: 104, l: 102, c: 104, v: 2500 },
    { t: 4, o: 104, h: 105, l: 103, c: 105, v: 2400 },
    // Pullback bars (lighter volume, low touches near EMA 103)
    { t: 5, o: 105, h: 105, l: 103.5, c: 103.8, v: 600 },
    { t: 6, o: 103.8, h: 104, l: 102.8, c: 103.0, v: 700 },
    { t: 7, o: 103.0, h: 103.5, l: 102.5, c: 103.2, v: 800 },
    // Reversal bar turning back green above prev bar high (103.5)
    { t: 8, o: 103.0, h: 104.2, l: 103.0, c: 104.0, v: 1500 }
  ];

  const ctx = {
    bars,
    open: 100,
    c: 104.0,
    vw: 103.0,
    e9: 103.2,
    e21: 101.8
  };

  const sigB = engine.checkSetupB(ctx, 1);
  assert.ok(sigB, 'Should detect Setup B pullback continuation');
  assert.equal(sigB.setup, 'B');
  assert.equal(sigB.dir, 1);
  assert.equal(sigB.rawStop, 102.5); // pullback swing low
});

test('v5: Setup C detects afternoon consolidation breakout (13:30 - 14:45)', () => {
  const engine = new V5Engine({});
  // Up 1.5% from open (100 to 101.5), then 10 bars consolidation between 101.2 and 101.7 (range < 0.5%), then bar 15 breaks out with high vol
  const bars = [];
  bars.push({ t: 1, o: 100, h: 101.5, l: 99.8, c: 101.4, v: 3000 });
  for (let i = 2; i <= 11; i++) {
    bars.push({ t: i, o: 101.4, h: 101.7, l: 101.2, c: 101.5, v: 500 });
  }
  // Breakout bar with 1500 volume (> 1.3x 500)
  bars.push({ t: 12, o: 101.5, h: 102.3, l: 101.4, c: 102.1, v: 1600 });

  const ctx = {
    bars,
    open: 100,
    c: 102.1,
    vw: 101.3
  };

  const sigC = engine.checkSetupC(ctx, 1);
  assert.ok(sigC, 'Should detect Setup C consolidation breakout');
  assert.equal(sigC.setup, 'C');
  assert.equal(sigC.dir, 1);
  assert.equal(sigC.rawStop, 101.2); // opposite side of consolidation
});

test('v5: stop clamping and 1.5R target calculation', () => {
  const engine = new V5Engine({ v5Capital: 50000, riskPct: 1, minStopPct: 0.4, maxStopPct: 1.2, v5RR: 1.5 });
  engine.state = engine.fresh('2026-10-06');

  const signal = { setup: 'A', dir: 1, rawStop: 99.8, why: 'Breakout' }; // stop is 0.2% away (too tight)
  const ctx = { c: 100 };
  const score = { score: 85, parts: {} };

  const pos = engine.enterTrade('TEST', signal, ctx, score, Date.now());
  assert.ok(pos);
  assert.equal(pos.stopPct, 0.4, 'Should be clamped to minStopPct (0.4%)');
  assert.equal(pos.stop, 99.6);
  assert.equal(pos.target, 100.6); // 1.5 * 0.4% = +0.6% -> 100.6
});

test('v5: position exit on target hit with positive net PnL', () => {
  const engine = new V5Engine({ v5Capital: 50000, riskPct: 1 });
  engine.state = engine.fresh('2026-10-06');

  const signal = { setup: 'A', dir: 1, rawStop: 99.0, why: 'Breakout' }; // 1.0% stop
  const ctx = { c: 100 };
  const score = { score: 80, parts: {} };

  const pos = engine.enterTrade('TEST', signal, ctx, score, Date.now());
  assert.ok(pos);

  // Manage position: price touches target (101.5)
  engine.managePositions({ TEST: 101.5 }, Date.now(), false);
  assert.equal(engine.state.positions.length, 0);
  assert.equal(engine.state.closed.length, 1);

  const trade = engine.state.closed[0];
  assert.equal(trade.exitReason, 'target');
  assert.ok(trade.netPnL > 0);
  assert.ok(trade.r > 1.3, `Expected ~1.5R minus charges, got ${trade.r}R`);
});

test('v5: square off at 15:15 exits remaining positions with reason "time"', () => {
  const engine = new V5Engine({ v5Capital: 50000 });
  engine.state = engine.fresh('2026-10-06');

  const signal = { setup: 'B', dir: 1, rawStop: 99.0, why: 'Pullback' };
  const ctx = { c: 100 };
  const score = { score: 75, parts: {} };

  engine.enterTrade('TEST', signal, ctx, score, Date.now());
  assert.equal(engine.state.positions.length, 1);

  // 15:15 square off triggers
  engine.managePositions({ TEST: 100.5 }, Date.now(), true);
  assert.equal(engine.state.positions.length, 0);
  assert.equal(engine.state.closed.length, 1);
  assert.equal(engine.state.closed[0].exitReason, 'time');
});

test('v5: no re-entry, a stock that already traded today is not entered again (even by another setup)', () => {
  const engine = new V5Engine({ v5Capital: 50000, riskPct: 1 });
  engine.state = engine.fresh('2026-10-08');
  const now = Date.parse('2026-10-08T05:30:00Z');
  const signal = { setup: 'A', dir: -1, rawStop: 101.0, why: 'Breakdown' };
  const score = { score: 90, parts: {} };
  assert.ok(engine.enterTrade('TEST', signal, { c: 100 }, score, now));
  engine.managePositions({ TEST: 98.5 }, now + 60000, false);          // target: closed
  assert.equal(engine.state.positions.length, 0);
  assert.equal(engine.enterTrade('TEST', { ...signal, setup: 'B' }, { c: 98.4 }, score, now + 120000), null, 'same stock, same day: refused');
  assert.ok(engine.enterTrade('OTHER', signal, { c: 100 }, score, now + 120000), 'another stock is still allowed');
  assert.ok(engine.enterTrade('TEST', signal, { c: 100 }, score, now + 86400000 * 1), 'next day it can trade again');
});
