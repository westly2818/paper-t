const test = require('node:test');
const assert = require('node:assert');
const { simulateDay, expiryFor, expiryMs, charges, IST } = require('../lib/straddle');

const day = '2026-10-07';                       // Wednesday; weekly expiry is Tuesday 13 Oct
const t0 = Date.parse(day + 'T00:00:00Z') - IST + (9 * 60 + 15) * 60000;
const flat = (spot, n = 375) => ({ t0, O: new Array(n).fill(spot), H: new Array(n).fill(spot), L: new Array(n).fill(spot), C: new Array(n).fill(spot) });
const base = { expiry: '2026-10-13', slPct: 0.4, slip: 0.01, ivScale: 0.9, lot: 65, entryMin: 45, exitMin: 345, r: 0.065, clock: 'trading', remainingDays: 4 };
const vix = new Array(375).fill(14);

test('weekly expiry: Thursday before September 2025, Tuesday after, holiday moves it earlier', () => {
  const all = new Set(['2025-08-25', '2025-08-26', '2025-08-27', '2025-08-28', '2025-09-01', '2025-09-02', '2026-10-12']);
  assert.strictEqual(expiryFor('2025-08-26', all, '2026-10-12'), '2025-08-28');
  assert.strictEqual(expiryFor('2025-09-01', all, '2026-10-12'), '2025-09-02');
  assert.strictEqual(expiryFor('2025-08-29', all, '2026-10-12'), '2025-09-02');
  const noTue = new Set(['2025-09-01', '2025-09-02'].slice(0, 1).concat(['2025-09-03']));
  assert.strictEqual(expiryFor('2025-09-01', noTue, '2026-10-12'), '2025-09-01');
});

test('a flat market: the seller earns time decay; slippage and charges take part of it', () => {
  const free = simulateDay(flat(22400), vix, { ...base, slip: 0 });
  const real = simulateDay(flat(22400), vix, base);
  assert.ok(free.gross > 0, 'decay ' + free.gross);
  assert.ok(real.gross < free.gross);
  assert.strictEqual(real.stops, 0);
  assert.ok(real.legs.every(l => l.why === 'time'));
  assert.ok(real.fee > 100 && real.fee < 400, 'fee ' + real.fee);
});

test('the trading-day clock gives more intraday decay than the calendar clock when a weekend is ahead', () => {
  const tr = simulateDay(flat(22400), vix, { ...base, slip: 0 }), cal = simulateDay(flat(22400), vix, { ...base, slip: 0, clock: 'calendar' });
  assert.ok(tr.gross > cal.gross * 2, 'trading ' + tr.gross + ' calendar ' + cal.gross);
});

test('a sharp rally stops the call leg at 40% above its sale price, the put leg is held', () => {
  const m = flat(22400); for (let j = 60; j < 375; j++) { m.O[j] = m.H[j] = m.L[j] = m.C[j] = 22700; }
  const r = simulateDay(m, vix, base);
  const ce = r.legs.find(l => l.type === 'CE'), pe = r.legs.find(l => l.type === 'PE');
  assert.match(ce.why, /^stop/); assert.strictEqual(pe.why, 'time');
  assert.ok(ce.exit >= ce.entry * 1.4 * 1.0099, 'exit ' + ce.exit + ' entry ' + ce.entry);
});

test('a gap through the stop fills at the worse open price, not at the trigger', () => {
  const m = flat(22400); for (let j = 100; j < 375; j++) { m.O[j] = m.H[j] = m.L[j] = m.C[j] = 22900; }
  const r = simulateDay(m, vix, base);
  const ce = r.legs.find(l => l.type === 'CE');
  assert.match(ce.why, /gap/); assert.ok(ce.exit > ce.entry * 1.4 * 1.01 + 50);
});

test('without a stop a steady rally is a bigger loss than with a stop', () => {
  const m = flat(22400); for (let j = 60; j < 375; j++) { const v = 22400 + Math.min(500, (j - 60) * 4); m.O[j] = m.H[j] = m.L[j] = m.C[j] = v; }
  const none = simulateDay(m, vix, { ...base, slPct: null }), stop = simulateDay(m, vix, base);
  assert.ok(stop.net > none.net, 'stop ' + stop.net + ' none ' + none.net);
});

test('higher slippage costs money on the same path', () => {
  const a = simulateDay(flat(22400), vix, { ...base, slip: 0.005 }), b = simulateDay(flat(22400), vix, { ...base, slip: 0.02 });
  assert.ok(a.net > b.net);
});

test('charges: STT only on the sell side, brokerage per order', () => {
  const c = charges([{ side: 'SELL', value: 10000 }, { side: 'BUY', value: 10000 }], {});
  const stt = 10000 * 0.001, brk = 40, txn = 20000 * 0.0003503, sebi = 20000 * 0.000001, stamp = 10000 * 0.00003, gst = 0.18 * (brk + txn + sebi);
  assert.ok(Math.abs(c - (stt + brk + txn + sebi + stamp + gst)) < 1e-9);
});
