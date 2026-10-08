const test = require('node:test');
const assert = require('node:assert');
const { planCondor, closeCost, settleLegs, FnoBook } = require('../lib/fno');
const { atMinute } = require('../lib/time');

// a chain around 22,500 with simple premiums that fall away from the money
function rowsFor(spot) {
  const rows = [];
  for (let k = spot - 1500; k <= spot + 1500; k += 50) {
    const dc = Math.max(0, k - spot), dp = Math.max(0, spot - k);
    const callMid = Math.max(2, 180 * Math.exp(-dc / 220) + Math.max(0, spot - k) * 0.9), putMid = Math.max(2, 180 * Math.exp(-dp / 220) + Math.max(0, k - spot) * 0.9);
    rows.push({ strike: k, type: 'CE', bid: callMid - 0.5, ask: callMid + 0.5, ltp: callMid, oi: 1000 }, { strike: k, type: 'PE', bid: putMid - 0.5, ask: putMid + 0.5, ltp: putMid, oi: 1000 });
  }
  return rows;
}
const chain = { spot: 22500, vix: 14, rows: rowsFor(22500) };

test('condor: shorts one standard deviation out, protection 1% further, sold at bid and bought at ask', () => {
  const p = planCondor(chain, 6, 65, 200000, 25);
  assert.strictEqual(p.ok, true);
  const sigma = 22500 * 0.14 * Math.sqrt(6 / 365);
  assert.strictEqual(p.legs[0].strike, Math.round((22500 + sigma) / 50) * 50);
  assert.strictEqual(p.legs[1].strike, Math.round((22500 - sigma) / 50) * 50);
  assert.strictEqual(p.legs[2].strike - p.legs[0].strike, 250);   // 1% of 22,500 rounded to 50
  const sellRow = chain.rows.find(r => r.type === 'CE' && r.strike === p.legs[0].strike);
  assert.strictEqual(p.legs[0].price, sellRow.bid);
  const buyRow = chain.rows.find(r => r.type === 'CE' && r.strike === p.legs[2].strike);
  assert.strictEqual(p.legs[2].price, buyRow.ask);
  assert.ok(p.credit > 0 && p.lots >= 1);
});

test('condor: skips the week when one lot risks more than the allowed share of capital', () => {
  const p = planCondor(chain, 6, 65, 50000, 5);
  assert.strictEqual(p.ok, false);
  assert.match(p.why, /one lot risks/);
});

test('close cost buys shorts at the ask and sells protection at the bid; settlement uses intrinsic value', () => {
  const p = planCondor(chain, 6, 65, 200000, 25);
  const pos = { legs: p.legs };
  const c = closeCost(pos, chain.rows);
  assert.ok(Math.abs(c - (p.credit + 4 * 0.5 - 0)) < 6);          // about the credit plus the spread paid twice
  const settled = settleLegs(pos, 22500);
  assert.ok(settled.every(l => l.price === 0));                   // all four strikes are out of the money at the old spot
  const crash = settleLegs(pos, p.legs[1].strike - 100);          // 100 points below the short put
  assert.strictEqual(crash.find(l => l.price > 0).price, 100);
});

test('book: sells on a Wednesday at 10:00, stops out at 1.5x the credit, exits at 15:15 on expiry day, one entry per day', async () => {
  const mem = {}, store = { get: async k => mem[k] || null, set: async (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); }, push: async () => {} };
  let current = { spot: 22500, vix: 14, rows: rowsFor(22500) };
  const fetchImpl = async () => ({ json: async () => ({ s: 'ok', data: { expiryData: [{ date: '13-10-2026', expiry: '1791886200' }], indiavixData: { ltp: current.vix }, optionsChain: [{ strike_price: -1, ltp: current.spot }, ...current.rows.map(r => ({ strike_price: r.strike, option_type: r.type, bid: r.bid, ask: r.ask, ltp: r.ltp, oi: r.oi }))] } }) });
  const book = new FnoBook({ fnoCapital: 200000, fnoLot: 65, fnoMaxRiskPct: 25 }, { store, fyers: { get: async () => ({ appId: 'A', access_token: 'T' }) }, fetch: fetchImpl });
  await book.load();
  const wed = '2026-10-07';
  await book.tick(atMinute(wed, 9 * 60 + 40));
  assert.strictEqual(book.state.pos, null);                       // too early
  await book.tick(atMinute(wed, 10 * 60 + 1));
  assert.ok(book.state.pos, 'entered');
  assert.strictEqual(book.state.pos.legs.length, 4);
  const credit = book.state.pos.credit, qty = book.state.pos.qty;
  // market sells off hard: premiums of the short put explode
  current = { spot: 21800, vix: 20, rows: rowsFor(21800) };
  await book.tick(atMinute(wed, 11 * 60));
  assert.strictEqual(book.state.pos, null, 'stopped out');
  assert.match(book.state.closed[0].reason, /Stop/);
  assert.ok(book.state.closed[0].net < 0 && book.state.closed[0].gross <= -1.5 * credit * qty + 1);
  await book.tick(atMinute(wed, 11 * 60 + 5));
  assert.strictEqual(book.state.pos, null);                       // no second entry the same day
});
