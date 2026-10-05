// Weekends and holidays must not build a plan, call the news API, or leave a day record.
const test = require('node:test');
const assert = require('node:assert');
const base = require('../config');
const { Engine } = require('../lib/engine');

const IST = 5.5 * 3600e3;
const at = (y, m, d, hh, mm) => Date.UTC(y, m - 1, d, hh, mm) - IST;

function make(nowMs, provider, over = {}) {
  const cfg = { ...base, mode: 'live', newsGuard: true, newsAuto: true, upstashUrl: null, stateFile: null, ...over };
  process.env.GEMINI_API_KEY = 'test-key';
  const eng = new Engine(cfg, provider, { now: () => nowMs, paused: false, speed: 1, finished: () => false });
  let newsCalls = 0;
  eng.checkNews = async ({ symbols }) => { newsCalls++; return { model: 'm', market: { risk: 'normal', summary: '', sources: [] }, stocks: Object.fromEntries(symbols.map(s => [s, { block: false, verified: true, reason: 'ok', sources: [] }])), windowHours: 36 }; };
  eng.preMarket = async function () { this.S.watch = { picked: [{ sym: 'AAA', bias: 'bull' }], backups: [], pool: [], rejected: [], failed: [], analyzed: 1, news: {} }; };
  eng.loadBaseline = async () => {};
  return { eng, calls: () => newsCalls };
}

test('Saturday: no plan, no news call, phase is weekend', async () => {
  const boom = () => { throw new Error('provider must not be used on a weekend'); };
  const { eng, calls } = make(at(2026, 10, 3, 10, 0), { daily: boom, intraday: boom });
  let planned = false;
  eng.preMarket = async () => { planned = true; };
  await eng.poll();
  assert.strictEqual(planned, false);
  assert.strictEqual(calls(), 0);
  assert.strictEqual(eng.S.phase, 'weekend');
  assert.strictEqual(eng.S.error, null);
});

test('weekday holiday: the index never trades, so the automatic news call never happens and no day record is written', async () => {
  const provider = { intraday: async () => [] };
  const { eng, calls } = make(at(2026, 10, 2, 10, 0), provider);
  await eng.poll();
  await eng.poll();
  assert.strictEqual(calls(), 0, 'no Gemini call on a holiday');
  assert.strictEqual(eng.S.watch.news.status, 'auto-pending');
  assert.strictEqual(eng.S.newsDone, false);
  eng.logDay();
  assert.strictEqual(eng.S.outbox.filter(o => o.name === 'days').length, 0, 'no day record for a day the market never opened');
});

test('trading day: the news call runs once the index has candles, and the day is logged', async () => {
  const candle = t => ({ t, o: 100, h: 101, l: 99, c: 100, v: 0 });
  const day0 = at(2026, 9, 30, 9, 15);
  const provider = { intraday: async () => [candle(day0), candle(day0 + 60000)] };
  const { eng, calls } = make(at(2026, 9, 30, 9, 20), provider, { upstashUrl: 'http://x' });
  await eng.poll();
  assert.strictEqual(calls(), 1);
  assert.strictEqual(eng.S.newsDone, true);
  assert.strictEqual(eng.S.tradingDay, true);
  eng.logDay();
  assert.strictEqual(eng.S.outbox.filter(o => o.name === 'days').length, 1);
});

test('before the open, the automatic news call waits (the manual box is not shown instead)', async () => {
  const provider = { intraday: async () => [] };
  const { eng, calls } = make(at(2026, 9, 30, 8, 30), provider);
  await eng.poll();
  assert.strictEqual(calls(), 0);
  assert.strictEqual(eng.S.watch.news.status, 'auto-pending');
});

test('version 3.1: entries until 10:30 and backups until 10:30', () => {
  assert.strictEqual(base.lastEntryMin, 10 * 60 + 30);
  assert.strictEqual(base.replaceUntilMin, base.lastEntryMin);
  assert.strictEqual(String(base.strategyVersion), '3.1');
});

test('universe archive waits for the close, and never runs on a non-trading day', async () => {
  const stored = { ...base, mode: 'live', upstashUrl: null, stateFile: '/tmp/x/state.json' };
  const eng = new Engine(stored, {}, { now: () => 0 });
  eng.S.day = '2026-10-05'; eng.S.tradingDay = true;
  eng.S.now = at(2026, 10, 5, 12, 0);
  await eng.archiveUniverse();
  assert.strictEqual(eng.S.archiveTries, 0, 'not before 15:38');
  eng.S.tradingDay = false; eng.S.now = at(2026, 10, 5, 16, 0);
  await eng.archiveUniverse();
  assert.strictEqual(eng.S.archiveTries, 0, 'not on a day the market never opened');
  eng.S.tradingDay = true; eng.S.archiveTries = 3;
  await eng.archiveUniverse();
  assert.strictEqual(eng.S.archiveTries, 3, 'gives up after 3 failed tries');
});
