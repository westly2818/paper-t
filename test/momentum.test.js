// The momentum book: rules, order maths, monthly schedule, retries, and isolation from errors.
const test = require('node:test');
const assert = require('node:assert');
const { MomentumBook, momentumPicks, planOrders, executeOrders } = require('../lib/momentum');
const { isWeekday } = require('../lib/time');

const IST = 5.5 * 3600e3;
const at = (y, m, d, hh, mm) => Date.UTC(y, m - 1, d, hh, mm) - IST;
const ymd = ms => new Date(ms + IST).toISOString().slice(0, 10);

// ---- synthetic market: 25 stocks, stock i drifts faster the larger i is; Nifty trends up or down ----
function sessions(from, count) { const out = []; let t = Date.UTC(...from); while (out.length < count) { if (isWeekday(t + 6 * 3600e3)) out.push(new Date(t).toISOString().slice(0, 10)); t += 86400000; } return out; }
const DAYS = sessions([2025, 5, 1], 560);
function series(p0, drift, volume, jump) {
  const d = DAYS, c = [], v = [];
  let p = p0;
  for (let i = 0; i < d.length; i++) { p *= 1 + drift + 0.004 * Math.sin(i * 1.7 + p0); if (jump && i === jump) p *= 1.6; c.push(p); v.push(volume); }
  return { d, c, v };
}
function market(niftyDrift) {
  const S = {};
  for (let i = 0; i < 25; i++) S['S' + String(i).padStart(2, '0')] = series(500 + i * 10, 0.0001 + (i - 12) * 0.00012, 2e6);
  S.JUMPER = series(600, 0.004, 2e6, 250);       // a corporate-action style jump inside the last year
  S.PRICEY = series(9000, 0.004, 2e6);           // above Rs 8,000
  S.THIN = series(600, 0.004, 1e3);              // too little turnover
  return { S, N: series(20000, niftyDrift, 0) };
}
const upTo = (s, day, includeToday) => { const d = [], c = [], v = []; for (let i = 0; i < s.d.length; i++) { if (s.d[i] > day || (s.d[i] === day && !includeToday)) continue; d.push(s.d[i]); c.push(s.c[i]); v.push(s.v[i]); } return { d, c, v }; };
function adapter(m, over = {}) {
  const prices = {};
  return {
    prices,
    symbols: () => Object.keys(m.S),
    daily: async (sym, day, inc) => upTo(sym === '^NSEI' ? m.N : m.S[sym], day, inc),
    price: async sym => { if (over.failPrice) throw new Error('price feed down'); return prices[sym] || m.S[sym].c[m.S[sym].c.length - 1]; },
    marketTraded: async () => !over.holiday
  };
}
function memoryStore() { const o = { kv: {}, lists: {} }; return { o, get: async n => (o.kv[n] ? JSON.parse(o.kv[n]) : null), set: async (n, v) => { o.kv[n] = JSON.stringify(v); }, push: async (n, r) => { (o.lists[n] = o.lists[n] || []).push(r); }, list: async n => o.lists[n] || [] }; }
const cfg = { mbookCapital: 50000, mbookSlots: 10, mbookRebalanceMin: 630, indexSymbol: '^NSEI', watchlist: [] };
const newBook = (m, over) => { const store = memoryStore(), b = new MomentumBook(cfg, { store, data: adapter(m, over) }); b.state = b.fresh(); return { b, store }; };

const lastDay = DAYS[DAYS.length - 1];
const slicesAt = (m, day) => { const S = {}; for (const k of Object.keys(m.S)) S[k] = upTo(m.S[k], day, false); return { S, N: upTo(m.N, day, false) }; };

test('picks: top momentum first; jump, price, turnover and stale guards work', () => {
  const m = market(0.0006), { S, N } = slicesAt(m, '2026-06-30');
  const r = momentumPicks(S, N, 10);
  assert.strictEqual(r.regimeOn, true);
  assert.deepStrictEqual(r.picks.map(p => p.sym), ['S24', 'S23', 'S22', 'S21', 'S20', 'S19', 'S18', 'S17', 'S16', 'S15']);
  assert.ok(!r.picks.some(p => ['JUMPER', 'PRICEY', 'THIN'].includes(p.sym)), 'excluded stocks never appear');
  assert.strictEqual(r.eligibleCount, 25);
  S.S24.d.pop(); S.S24.c.pop(); S.S24.v.pop(); // no bar for the latest session
  assert.ok(!momentumPicks(S, N, 10).picks.some(p => p.sym === 'S24'), 'a stock with no bar for the latest session is skipped');
});

test('regime is off when Nifty is below its 200-day average', () => {
  const m = market(-0.0008), { S, N } = slicesAt(m, '2026-06-30');
  assert.strictEqual(momentumPicks(S, N, 10).regimeOn, false);
});

test('plan: keep holdings that stay, sell leavers, buy entrants; regime off sells everything', () => {
  const m = market(0.0006), { S, N } = slicesAt(m, '2026-06-30'), res = momentumPicks(S, N, 10);
  const held = [{ sym: 'S24', qty: 5 }, { sym: 'S03', qty: 9 }];
  const plan = planOrders(held, res, 10);
  assert.deepStrictEqual(plan.sells.map(o => o.sym), ['S03']);
  assert.strictEqual(plan.buys.length, 9);
  assert.ok(!plan.buys.some(b => b.sym === 'S24'));
  const off = planOrders(held, { ...res, regimeOn: false }, 10);
  assert.deepStrictEqual(off.sells.map(o => o.sym).sort(), ['S03', 'S24']);
  assert.strictEqual(off.buys.length, 0);
  assert.strictEqual(planOrders([], { ...res, eligibleCount: 12 }, 10).buys.length, 0, 'fewer than 20 eligible stocks means no buying');
});

test('execution: equal budgets, charges paid, cash and cost accounting add up', () => {
  const book = { cash: 50000, positions: [] };
  const plan = { sells: [], buys: Array.from({ length: 10 }, (_, i) => ({ sym: 'S' + i, mom: 0.5, rank: i + 1 })) };
  const prices = Object.fromEntries(plan.buys.map((b, i) => [b.sym, 100 + i * 37]));
  const t = executeOrders(book, plan, prices, 10, '2026-07-01', 0);
  assert.strictEqual(t.filter(x => x.side === 'BUY').length, 10);
  for (const p of book.positions) assert.ok(p.cost <= 5000.0001 && p.cost > 4000, 'each position uses about a tenth of the capital: ' + p.cost);
  const spent = book.positions.reduce((a, p) => a + p.cost, 0);
  assert.ok(Math.abs(50000 - book.cash - spent) < 1e-6, 'cash plus cost equals the start');
  const sell = executeOrders(book, { sells: [{ sym: 'S0', qty: book.positions[0].qty, reason: 'x' }], buys: [] }, prices, 10, '2026-08-03', 0);
  assert.ok(sell[0].fee > 0 && sell[0].pnl < 0, 'selling at the same price loses the charges and slippage');
});

test('schedule: nothing on weekends or holidays; one rebalance per month; first run in a bearish market goes to cash', async () => {
  const m = market(-0.0008), { b, store } = newBook(m);
  await b.tick(at(2026, 6, 6, 11, 0));   // Saturday
  assert.strictEqual(b.state.lastRebalanceMonth, null);
  const { b: h } = newBook(m, { holiday: true });
  await h.tick(at(2026, 6, 1, 11, 0));
  assert.strictEqual(h.state.lastRebalanceMonth, null, 'a holiday is not a rebalance day');
  await b.tick(at(2026, 6, 1, 10, 0));   // before 10:30
  assert.strictEqual(b.state.lastRebalanceMonth, null);
  await b.tick(at(2026, 6, 1, 10, 31));
  assert.strictEqual(b.state.lastRebalanceMonth, '2026-06');
  assert.strictEqual(b.state.positions.length, 0);
  assert.ok(Math.abs(b.state.cash - 50000) < 1e-9);
  const events = b.state.events.length;
  await b.tick(at(2026, 6, 2, 11, 0));
  assert.strictEqual(b.state.events.length, events, 'the same month is never rebalanced twice');
  assert.ok(store.o.kv.state, 'state is saved');
});

test('bullish month: buys 10, then next month keeps the stays and sells the leavers; evening marks and prepares the list', async () => {
  const m = market(0.0006), { b, store } = newBook(m);
  await b.tick(at(2026, 6, 1, 10, 45));
  assert.strictEqual(b.state.positions.length, 10);
  assert.deepStrictEqual(b.state.positions.map(p => p.sym).sort(), ['S15', 'S16', 'S17', 'S18', 'S19', 'S20', 'S21', 'S22', 'S23', 'S24']);
  assert.ok(store.o.lists.trades.length === 10, 'every buy is logged');
  await b.tick(at(2026, 6, 1, 15, 55));
  assert.strictEqual(b.state.lastMarkDay, '2026-06-01');
  assert.strictEqual(b.state.curve.length, 1);
  assert.ok(b.state.preview && b.state.preview.picks.length === 10, 'tomorrow\'s list is prepared in the evening');
  assert.strictEqual(store.o.lists.days.length, 1);
  // the leaders change: make S05 the strongest and S15 the weakest of the held names
  m.S.S05 = series(500, 0.003, 2e6); m.S.S15 = series(650, -0.002, 2e6);
  b.state.preview = null;
  const before = b.state.positions.map(p => p.sym);
  await b.tick(at(2026, 7, 1, 10, 40));
  const after = b.state.positions.map(p => p.sym);
  assert.ok(!after.includes('S15') && after.includes('S05'), 'weak holding sold, new leader bought');
  for (const keep of before.filter(s => s !== 'S15')) assert.ok(after.includes(keep) || !momentumPicks(...Object.values(slicesAt(m, '2026-06-30')), 10).picks.some(p => p.sym === keep), 'unchanged holdings are kept');
  assert.strictEqual(b.state.lastRebalanceMonth, '2026-07');
});

test('a failing price feed changes nothing and is retried on the next tick', async () => {
  const m = market(0.0006), over = { failPrice: true }, { b } = newBook(m, over);
  await b.tick(at(2026, 6, 1, 10, 45));
  assert.strictEqual(b.state.positions.length, 0);
  assert.strictEqual(b.state.lastRebalanceMonth, null, 'still waiting to rebalance');
  assert.ok(b.state.events.some(e => e.kind === 'warn'), 'the error is logged');
  assert.strictEqual(b.running, false);
  over.failPrice = false;
  await b.tick(at(2026, 6, 1, 10, 46));
  assert.strictEqual(b.state.positions.length, 10);
});

test('no rebalance is attempted after 15:00; it waits for the next trading day', async () => {
  const m = market(0.0006), { b } = newBook(m);
  await b.tick(at(2026, 6, 1, 15, 10));
  assert.strictEqual(b.state.lastRebalanceMonth, null);
  await b.tick(at(2026, 6, 2, 10, 35));
  assert.strictEqual(b.state.lastRebalanceMonth, '2026-06');
});
