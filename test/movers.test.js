// The mover scanner: features, selection, outcomes, statistics, the daily schedule, and its failure paths.
const test = require('node:test');
const assert = require('node:assert');
const { MoverScanner, sessionsOf, moverFeatures, selectMovers, outcomeOf, summarize, indexMove } = require('../lib/movers');
const { validate } = require('../lib/catalyst');
const { isWeekday } = require('../lib/time');

const IST = 5.5 * 3600e3;
const at = (y, m, d, hh, mm) => Date.UTC(y, m - 1, d, hh, mm) - IST;
function weekdays(endDay, count) { const out = []; let t = Date.parse(endDay + 'T00:00:00Z'); while (out.length < count) { if (isWeekday(t + 6 * 3600e3)) out.unshift(new Date(t).toISOString().slice(0, 10)); t -= 86400000; } return out; }
// a day of 75 five-minute bars. spec: { price (flat), vol (per bar), open, early (price from the 09:30 bar on), late (price from 10:30) }
function dayBars(day, { price = 100, vol = 1000, open = null, c3 = null, after = null } = {}) {
  const [y, m, d] = day.split('-').map(Number), bars = [];
  for (let k = 0; k < 75; k++) {
    const t = Date.UTC(y, m - 1, d, 3, 45) + k * 300000;
    let o = price, c = price;
    if (k === 0 && open != null) o = open;
    if (k <= 3 && c3 != null) c = k === 3 ? c3 : (open != null ? open : price);
    if (k >= 4 && after != null) { o = c = after(k); }
    bars.push({ t, o, h: Math.max(o, c) * 1.001, l: Math.min(o, c) * 0.999, c, v: vol });
  }
  return bars;
}
const PREV = weekdays('2026-09-30', 25), TODAY = '2026-10-01';
const history = (price = 100, vol = 1000) => PREV.flatMap(d => dayBars(d, { price, vol }));

test('features: gap, move at 09:35, and early volume against its own usual', () => {
  const bars = [...history(), ...dayBars(TODAY, { open: 103, c3: 105, vol: 3000 })];
  const f = moverFeatures(sessionsOf(bars), TODAY);
  assert.ok(Math.abs(f.gapPct - 3) < 1e-9 && Math.abs(f.movePct - 5) < 1e-9);
  assert.ok(Math.abs(f.rvol - 3) < 1e-9, 'three times the usual early volume: ' + f.rvol);
  assert.strictEqual(f.prevClose, 100);
  assert.strictEqual(moverFeatures(sessionsOf(dayBars(TODAY, { open: 103, c3: 105 })), TODAY), null, 'no history means no verdict');
});

test('selection: 2% or more either way, liquid enough, biggest first, strong volume flagged', () => {
  const mk = (movePct, rvol, turnover = 1e9) => ({ f: { movePct, gapPct: movePct, rvol, turnover, prevClose: 100, ref: 100 + movePct } });
  const list = [{ sym: 'A', ...mk(2.5, 1.0) }, { sym: 'B', ...mk(-4, 2.0) }, { sym: 'C', ...mk(1.9, 5) }, { sym: 'D', ...mk(6, 3, 1e6) }, { sym: 'E', f: null }];
  const m = selectMovers(list, { minTurnover: 3e8 });
  assert.deepStrictEqual(m.map(x => x.sym), ['B', 'A']);
  assert.deepStrictEqual(m.map(x => x.dir), [-1, 1]);
  assert.deepStrictEqual(m.map(x => x.strongVolume), [true, false]);
});

test('index move needs no volume', () => {
  const m = indexMove(sessionsOf([...PREV.flatMap(d => dayBars(d, { price: 1000, vol: 0 })), ...dayBars(TODAY, { price: 1000, open: 1005, c3: 1010, vol: 0 })]), TODAY);
  assert.ok(Math.abs(m.movePct - 1) < 1e-9);
});

test('outcomes are signed in the mover\'s direction and adjusted for Nifty', () => {
  const up = sessionsOf(dayBars(TODAY, { open: 103, c3: 105, after: k => 105 + (k - 3) * 0.1 })).get(TODAY);
  const nifty = sessionsOf(dayBars(TODAY, { price: 1000, vol: 0, after: k => 1000 + (k - 3) * 0.5 })).get(TODAY);
  const o = outcomeOf(up, nifty, 1);
  assert.ok(o.ret.r1030 > 0 && o.ret.r1515 > o.ret.r1030, 'kept going');
  assert.ok(o.adj.r1515 < o.ret.r1515 || o.adj.r1515 > o.ret.r1515 - 5);
  const down = outcomeOf(up, nifty, -1);
  assert.ok(Math.abs(down.ret.r1515 + o.ret.r1515) < 1e-9, 'the same price path is the opposite result for a down-mover');
  assert.ok(o.mfe > 0 && o.mae <= 0.2);
  assert.strictEqual(outcomeOf(undefined, nifty, 1), null);
});

test('summary: groups, day-clustered t, and the cost hurdle', () => {
  const scans = [], outs = [];
  for (let i = 0; i < 12; i++) {
    const day = '2026-09-' + String(i + 1).padStart(2, '0');
    scans.push({ day, sym: 'S' + i, dir: 1, movePct: 3, gapPct: 3.2, rvol: 2, strongVolume: true, catalyst: { verified: true, explainsMove: true, category: 'results', sentiment: 'positive' } });
    scans.push({ day, sym: 'N' + i, dir: -1, movePct: -3, gapPct: -1, rvol: 1, strongVolume: false, catalyst: { verified: true, explainsMove: false, category: 'none' } });
    outs.push({ day, sym: 'S' + i, ret: { r1030: 0.2, r1200: 0.4, r1515: 0.5 + (i % 2) * 0.2, r1330: 0.3, rClose: 0.5 }, adj: { r1515: 0.3 }, mfe: 1, mae: -0.3 });
    outs.push({ day, sym: 'N' + i, ret: { r1030: -0.1, r1200: -0.2, r1515: -0.3, r1330: 0, rClose: -0.3 }, adj: { r1515: -0.4 }, mfe: 0.2, mae: -0.8 });
  }
  const s = summarize(scans, outs), g = n => s.groups.find(x => x.name === n);
  assert.strictEqual(s.rows, 24);
  assert.strictEqual(g('News explains the move').n, 12);
  assert.ok(Math.abs(g('News explains the move').r1515 - 0.6) < 1e-9);
  assert.ok(Math.abs(g('News explains the move').net - (0.6 - 0.14)) < 1e-9, 'charges are subtracted');
  assert.strictEqual(g('Strong volume AND news explains it').n, 12);
  assert.strictEqual(g('Up-moves').n, 12);
  assert.ok(g('News category: results'), 'a category with 5+ explained movers gets its own row');
  assert.strictEqual(g('News explains the move').days, 12);
});

test('catalyst check: evidence must be this stock\'s own headline, and anything unverifiable stays unverified', () => {
  const H = n => ({ ok: true, kept: Array.from({ length: n }, (_, i) => ({ title: 'h' + (i + 1), url: 'https://x.test/' + (i + 1), source: 's', publishedMs: Date.now() })) });
  const movers = [{ sym: 'AAA' }, { sym: 'BBB' }, { sym: 'CCC' }, { sym: 'DDD' }];
  const headlines = { AAA: H(3), BBB: H(0), CCC: { ok: false, error: 'HTTP 503' }, DDD: H(2) };
  const j = { stocks: [
    { symbol: 'AAA', category: 'results', sentiment: 'positive', explains_move: true, reason: 'strong results', evidence: ['AAA#2', 'DDD#1', 'AAA#9'] },
    { symbol: 'DDD', category: 'results', sentiment: 'positive', explains_move: true, reason: 'no evidence cited', evidence: [] }] };
  const v = validate(j, movers, headlines);
  assert.strictEqual(v.AAA.explainsMove, true);
  assert.strictEqual(v.AAA.sources.length, 1);
  assert.strictEqual(v.AAA.sources[0].url, 'https://x.test/2');
  assert.strictEqual(v.BBB.explainsMove, false, 'no headlines before the move is a real answer: no reason');
  assert.strictEqual(v.BBB.verified, true);
  assert.strictEqual(v.CCC.explainsMove, null, 'a feed failure is unverified');
  assert.strictEqual(v.DDD.explainsMove, null, 'a claim with no cited headline is unverified');
});

// ---- the scanner, with a fake data feed and a fake news classifier ----
const syms = Array.from({ length: 30 }, (_, i) => 'T' + String(i).padStart(2, '0'));
const cfg = { watchlist: syms, indexSymbol: '^NSEI', minTurnover: 1e6, geminiModel: 'm', upstashUrl: null };
function memoryStore() { const o = { kv: {}, lists: {} }; return { o, get: async n => (o.kv[n] ? JSON.parse(o.kv[n]) : null), set: async (n, v) => { o.kv[n] = JSON.stringify(v); }, push: async (n, r) => { (o.lists[n] = o.lists[n] || []).push(r); }, list: async n => o.lists[n] || [] }; }
function feed(over = {}) {
  const calls = { bars: 0 };
  return {
    calls,
    symbols: () => syms,
    bars5m: async sym => {
      calls.bars++;
      if (over.fail) throw new Error('feed down');
      if (sym === '^NSEI') return [...PREV.flatMap(d => dayBars(d, { price: 1000, vol: 0 })), ...dayBars(TODAY, { price: 1000, vol: 0 })];
      const mover = sym === 'T05' ? { open: 103, c3: 105, vol: 3000, after: k => 105 + (k - 3) * 0.1 } : sym === 'T06' ? { open: 97, c3: 96, vol: 2500, after: k => 96 - (k - 3) * 0.05 } : {};
      const gaps = over.noBar3 ? [] : null;
      const today = dayBars(TODAY, mover);
      return [...history(), ...(over.partial && sym > 'T10' ? today.slice(0, 3) : today)];
    },
    marketTraded: async () => !over.holiday
  };
}
function make(over, classify) {
  const store = memoryStore(), data = feed(over);
  const sc = new MoverScanner(cfg, { store, data, classify: classify || (async ({ movers }) => ({ model: 'fake', byStock: Object.fromEntries(movers.map(m => [m.sym, { category: m.dir === 1 ? 'upgrade_downgrade' : 'regulatory_or_legal', sentiment: m.dir === 1 ? 'positive' : 'negative', explainsMove: true, verified: true, reason: 'fake', sources: [] }])) })), names: new Map(syms.map(s => [s, s + ' Ltd'])), key: () => 'k' });
  sc.state = sc.fresh();
  return { sc, store, data };
}

test('scanner: nothing on weekends, holidays, or before 09:38; one scan per day; movers saved with their news reason', async () => {
  const { sc, store, data } = make();
  await sc.tick(at(2026, 10, 3, 9, 45));            // Saturday
  await sc.tick(at(2026, 10, 1, 9, 30));            // before the scan time
  assert.strictEqual(sc.state.today, null);
  assert.strictEqual(data.calls.bars, 0);
  const { sc: h } = make({ holiday: true });
  await h.tick(at(2026, 10, 1, 9, 45));
  assert.strictEqual(h.state.today, null, 'a holiday is not scanned');
  await sc.tick(at(2026, 10, 1, 9, 45));
  const T = sc.state.today;
  assert.strictEqual(T.day, TODAY);
  assert.deepStrictEqual(T.movers.map(m => m.sym), ['T05', 'T06'], 'only the two real movers, biggest first');
  assert.strictEqual(T.movers[0].strongVolume, true);
  assert.strictEqual(T.movers[0].catalyst.explainsMove, true);
  assert.strictEqual(store.o.lists.scans.length, 2, 'every mover is logged');
  const n = data.calls.bars;
  await sc.tick(at(2026, 10, 1, 10, 0));
  assert.strictEqual(data.calls.bars, n, 'the day is not scanned twice');
});

test('scanner: a news failure keeps the movers, marked unchecked', async () => {
  const { sc } = make({}, async () => { throw new Error('Gemini HTTP 429'); });
  await sc.tick(at(2026, 10, 1, 9, 45));
  assert.strictEqual(sc.state.today.movers.length, 2);
  assert.strictEqual(sc.state.today.movers[0].catalyst, null);
  assert.ok(/429/.test(sc.state.today.error));
});

test('scanner: waits and retries when the 09:35 bar is not available yet for most stocks', async () => {
  const { sc } = make({ partial: true });
  await sc.tick(at(2026, 10, 1, 9, 40));
  assert.strictEqual(sc.state.today, null, 'not marked as scanned');
  assert.ok(sc.state.events.some(e => /trying again/.test(e.text)));
});

test('scanner: a failing feed never throws out of tick', async () => {
  const { sc } = make({ fail: true });
  await sc.tick(at(2026, 10, 1, 9, 45));
  assert.strictEqual(sc.running, false);
  assert.strictEqual(sc.state.today, null);
});

test('outcomes: recorded after 15:45, shown next to each mover, and a missed day is caught up next day', async () => {
  const { sc, store } = make();
  await sc.tick(at(2026, 10, 1, 9, 45));
  await sc.tick(at(2026, 10, 1, 14, 0));
  assert.strictEqual((store.o.lists.outcomes || []).length, 0, 'too early');
  await sc.tick(at(2026, 10, 1, 15, 50));
  assert.strictEqual(store.o.lists.outcomes.length, 2);
  assert.strictEqual(sc.state.pending.length, 0);
  assert.ok(sc.state.today.outcomes.T05.r1515 > 0, 'the up-mover kept going');
  assert.ok(sc.state.today.outcomes.T06.r1515 > 0, 'the down-mover kept falling, which counts as going on');
  // a second scanner that was down all of 1 Oct: the pending day is processed on a later day
  const { sc: late, store: s2 } = make();
  await late.tick(at(2026, 10, 1, 9, 45));
  assert.strictEqual(late.state.pending.length, 1);
  await late.tick(at(2026, 10, 2, 9, 0));
  assert.strictEqual(late.state.pending.length, 0);
  assert.strictEqual(s2.o.lists.outcomes.length, 2);
});
