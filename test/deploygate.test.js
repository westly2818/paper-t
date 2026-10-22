const test = require('node:test');
const assert = require('node:assert');
const { GATE, metrics, evaluate, disposition, marketStatus } = require('../lib/deploygate');

// n trades over d days, r given by a function of the index
const rows = (n, f, per = 2) => Array.from({ length: n }, (_, i) => ({ day: new Date(Date.UTC(2026, 0, 5) + Math.floor(i / per) * 86400000).toISOString().slice(0, 10), sym: 'S' + (i % 40), opened: i, r: f(i), chargesR: 0.1 }));
const kinds = rows(300, () => 0).reduce((m, r, i) => { m[r.day] = i % 3 === 0 ? 'up' : i % 3 === 1 ? 'down' : 'flat'; return m; }, {});

test('drawdown, losing streak and halves are computed on the trade path', () => {
  const m = metrics(rows(10, i => [1, 1, -1, -1, -1, 1, -1, 1, 1, 1][i]));
  assert.strictEqual(m.n, 10); assert.strictEqual(m.maxLosingStreak, 3); assert.strictEqual(m.maxDrawdownR, 3);   // peak 2R after two wins, trough -1R
  assert.ok(Math.abs(m.firstHalfR - (-0.2)) < 1e-9 && Math.abs(m.secondHalfR - 0.6) < 1e-9);
});

test('concentration: best 10 trades and one stock', () => {
  const t = rows(60, i => (i < 10 ? 5 : -0.2));            // all profit in 10 trades
  const m = metrics(t); assert.ok(Math.abs(m.top10Share - 1) < 1e-9);
  const u = rows(100, i => (i % 2 ? 0.3 : -0.1)); u.forEach(x => { x.sym = 'ONE'; });
  assert.ok(Math.abs(metrics(u).maxSymbolShare - 1) < 1e-9);
});

test('a genuinely good record passes G1-G6 and still needs the historical test and the attestations', () => {
  const t = rows(150, i => (i % 5 === 0 ? -0.9 : 0.55 + (i % 7) * 0.02));         // steady edge, small losses
  const m = metrics(t, kinds); const c = evaluate(m, {});
  const byId = Object.fromEntries(c.map(x => [x.id, x.status]));
  assert.deepStrictEqual(['G1', 'G2', 'G3', 'G4', 'G5', 'G6'].map(k => byId[k]), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS']);
  assert.strictEqual(byId.G0, 'UNAVAILABLE'); assert.strictEqual(byId.G7, 'UNAVAILABLE'); assert.strictEqual(byId.G8, 'UNAVAILABLE');
  assert.strictEqual(disposition(c).code, 'KEEP IN PAPER');
  const full = evaluate(m, { hist: { trades: 5000, years: 5, devAvgR: 0.12, holdAvgR: 0.11, source: 'test' }, attest: { leakageReviewed: true, paperMatchesTest: true } });
  assert.strictEqual(disposition(full).code, 'DEPLOYMENT GATE PASSED');
});

test('a negative large-sample historical test is a REJECT, whatever the short live record says', () => {
  const lucky = metrics(rows(41, i => 0.2), kinds);                                  // 41 lucky trades
  const c = evaluate(lucky, { hist: { trades: 528000, years: 8, devAvgR: -0.111, holdAvgR: -0.13, source: 'intraday-lab' } });
  assert.strictEqual(c.find(x => x.id === 'G0').status, 'FAIL');
  assert.strictEqual(disposition(c).code, 'REJECT STRATEGY');
});

test('too few trades or no profit never passes; the disposition lists exactly what is missing', () => {
  const m = metrics(rows(41, i => (i % 2 ? 0.3 : -0.4)), kinds);
  const d = disposition(evaluate(m, {}));
  assert.strictEqual(d.code, 'KEEP IN PAPER'); assert.match(d.why, /G1/); assert.match(d.why, /G3/);
  assert.strictEqual(disposition(evaluate(m, {}), { shadow: true }).code, 'KEEP IN SHADOW');
});

test('thresholds are the locked values', () => {
  assert.deepStrictEqual([GATE.minTrades, GATE.minAvgR, GATE.minT, GATE.minGoodWeeks, GATE.maxDrawdownR, GATE.maxLosingStreak, GATE.maxTop10Share, GATE.maxSymbolShare], [100, 0.10, 2, 0.6, 10, 8, 0.5, 0.25]);
});

test('market status labels', () => {
  const bar = (o, h, l, c) => [0, o, h, l, c, 0];
  const mk = path => path.map((p, i) => bar(p[0], p[1], p[2], p[3]));
  const chop = Array.from({ length: 30 }, (_, i) => bar(100, 100.5 + (i % 2), 99.5 - (i % 2) * 0.2, i === 29 ? 100 : 100.1));
  assert.strictEqual(marketStatus(chop, 14).label, 'RANGING');
  const trend = Array.from({ length: 30 }, (_, i) => bar(100 + i * 0.05, 100.1 + i * 0.05, 99.95 + i * 0.05, 100.08 + i * 0.05));
  assert.strictEqual(marketStatus(trend, 14).label, 'TRENDING');
  assert.strictEqual(marketStatus(trend, 25).label, 'HIGH VOLATILITY');
  assert.strictEqual(marketStatus(chop.slice(0, 5), 14).label, 'UNCERTAIN');
});
