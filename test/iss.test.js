const test = require('node:test');
const assert = require('node:assert');
const { IssBook, planStraddle, checkExits } = require('../lib/iss');

const IST = 5.5 * 3600e3;
const at = (day, hhmm) => { const [h, m] = hhmm.split(':').map(Number); return Date.parse(day + 'T00:00:00Z') - IST + (h * 60 + m) * 60000; };
const mem = () => { const kv = {}, lists = {}; return { kv, lists, get: async k => kv[k] ?? null, set: async (k, v) => { kv[k] = JSON.parse(JSON.stringify(v)); }, push: async (k, r) => { (lists[k] = lists[k] || []).push(JSON.parse(JSON.stringify(r))); }, list: async k => lists[k] || [] }; };
// a chain around 22,400 with the ATM 22,400 options quoted (bid, ask)
const mkChain = (spot, ceBid, ceAsk, peBid, peAsk) => ({ spot, vix: 14, expiries: [{ date: '13-10-2026', expiry: 1 }], rows: [
  { strike: 22400, type: 'CE', bid: ceBid, ask: ceAsk, ltp: (ceBid + ceAsk) / 2, oi: 1 }, { strike: 22400, type: 'PE', bid: peBid, ask: peAsk, ltp: (peBid + peAsk) / 2, oi: 1 },
  { strike: 22450, type: 'CE', bid: 100, ask: 101, ltp: 100, oi: 1 }, { strike: 22350, type: 'PE', bid: 100, ask: 101, ltp: 100, oi: 1 }] });
function book(chainRef) {
  const store = mem(), b = new IssBook({ fnoLot: 65 }, { store, fyers: { get: async () => ({ appId: 'A', access_token: 'T' }) } });
  b.chain = async () => chainRef.current; b.state = b.fresh(); return { b, store };
}
const D = '2026-10-12';   // a Monday; the weekly expiry is Tuesday 13 Oct

test('plan: ATM strike, both legs sold at the bid, trigger 40% above the sale price', () => {
  const p = planStraddle(mkChain(22412, 99, 100, 98, 99), 65);
  assert.strictEqual(p.ok, true); assert.strictEqual(p.K, 22400);
  assert.deepStrictEqual(p.legs.map(l => l.sold), [99, 98]);
  assert.ok(Math.abs(p.legs[0].trigger - 99 * 1.4) < 1e-9);
  assert.ok(Math.abs(p.premium - 197) < 1e-9);
});

test('plan: no trade without a bid or without the strike', () => {
  assert.strictEqual(planStraddle(mkChain(22400, 0, 100, 98, 99), 65).ok, false);
  const far = planStraddle(mkChain(22700, 99, 100, 98, 99), 65);
  assert.strictEqual(far.ok, false); assert.match(far.why, /no 22700 strike/);
});

test('exits: a leg is bought at the ask when it reaches +40%, the time exit takes everything at 15:00', () => {
  const pos = { legs: planStraddle(mkChain(22400, 100, 101, 100, 101), 65).legs };
  assert.deepStrictEqual(checkExits(pos, mkChain(22400, 120, 121, 90, 91).rows, 11 * 60), []);
  const hit = checkExits(pos, mkChain(22400, 139, 141, 90, 91).rows, 11 * 60);
  assert.strictEqual(hit.length, 1); assert.strictEqual(hit[0].leg.type, 'CE'); assert.strictEqual(hit[0].price, 141); assert.match(hit[0].why, /^stop/);
  assert.strictEqual(checkExits(pos, mkChain(22400, 80, 81, 70, 71).rows, 15 * 60).length, 2);
});

test('a full day: sells at 10:00, stops one leg, exits the other at 15:00, charges and net are right, quotes are kept every 30 minutes', async () => {
  const c = { current: mkChain(22400, 100, 101, 100, 101) }, { b, store } = book(c);
  await b.tick(at(D, '09:45'));                                   // nothing yet
  assert.strictEqual(b.state.pos, null);
  await b.tick(at(D, '10:00'));
  assert.ok(b.state.pos, 'entered'); assert.strictEqual(b.state.pos.legs[0].sold, 100); assert.strictEqual(b.state.pos.qty, 65);
  await b.tick(at(D, '10:01'));                                   // same day: no second entry
  assert.strictEqual(b.state.closed.length, 0);
  c.current = mkChain(22400, 150, 152, 70, 71);                   // call leg up 52%: stop
  await b.tick(at(D, '11:00'));
  const ce = b.state.pos.legs[0], pe = b.state.pos.legs[1];
  assert.strictEqual(ce.open, false); assert.strictEqual(ce.exit, 152); assert.match(ce.why, /^stop/); assert.strictEqual(pe.open, true);
  c.current = mkChain(22400, 60, 61, 55, 56);
  await b.tick(at(D, '15:00'));
  assert.strictEqual(b.state.pos, null); assert.strictEqual(b.state.closed.length, 1);
  const r = b.state.closed[0];
  assert.strictEqual(r.points, (100 - 152) + (100 - 56)); assert.strictEqual(r.gross, -8 * 65);
  assert.ok(r.fees > 100 && r.fees < 400); assert.strictEqual(Math.round(r.net), Math.round(r.gross - r.fees)); assert.strictEqual(r.stops, 1);
  assert.strictEqual(store.lists['trades'].length, 1);
  const slots = store.lists['quotes'].map(q => q.mod); assert.deepStrictEqual([...new Set(slots)], slots, 'one quote per 30-minute slot');
  assert.ok(store.lists['quotes'].length >= 4);
});

test('a start after 10:30 skips the day instead of entering late', async () => {
  const { b } = book({ current: mkChain(22400, 100, 101, 100, 101) });
  await b.tick(at(D, '11:20'));
  assert.strictEqual(b.state.pos, null); assert.match(b.state.skippedDays[0].why, /too late/);
});

test('a position left open overnight is closed at the last quotes seen and flagged', async () => {
  const c = { current: mkChain(22400, 100, 101, 100, 101) }, { b } = book(c);
  await b.tick(at(D, '10:00')); await b.tick(at(D, '12:00'));
  const next = '2026-10-13';
  await b.tick(at(next, '09:30'));
  assert.strictEqual(b.state.pos, null); assert.strictEqual(b.state.closed[0].stale, true); assert.match(b.state.closed[0].legs[0].why, /server was off/);
});

test('snapshot totals', async () => {
  const c = { current: mkChain(22400, 100, 101, 100, 101) }, { b } = book(c);
  await b.tick(at(D, '10:00')); c.current = mkChain(22400, 60, 61, 55, 56); await b.tick(at(D, '15:00'));
  const s = b.snapshot();
  assert.strictEqual(s.totals.days, 1); assert.strictEqual(s.totals.wins, 1); assert.ok(s.totals.net > 0);
});
