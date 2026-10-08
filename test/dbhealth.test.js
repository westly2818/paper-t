const test = require('node:test');
const assert = require('node:assert');
const { assess, dayOf } = require('../lib/dbhealth');

const IST = 5.5 * 3600e3;
const at = (day, hhmm) => { const [h, m] = hhmm.split(':').map(Number); return Date.parse(day + 'T00:00:00Z') - IST + (h * 60 + m) * 60000; };
const DAYS = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'];
const all = () => ({ dayRecord: new Set(DAYS), candles: new Set(DAYS), bars5m: new Set(DAYS) });
const base = (over = {}) => {
  const now = at('2026-10-08', '17:00');
  return { now, uptimeMs: 3600e3, redis: { ok: true, usedMb: 2, maxMb: 64 }, engine: { lastSaveAt: now - 30e3, outbox: 0 }, tradingDays: DAYS, tradingDaysKnown: true, tradingToday: true,
    have: all(), logs: [], backup: { at: now - 86400e3, latestDay: '2026-10-08' }, ...over };
};
const codes = r => r.messages.map(m => m.code);

test('healthy: everything saved, backup a day old', () => {
  const r = assess(base());
  assert.strictEqual(r.status, 'ok'); assert.deepStrictEqual(r.messages, []);
  assert.ok(r.rows.every(x => x.candles === 'ok' && x.bars5m === 'ok' && x.dayRecord === 'ok'));
});

test('a past trading day without its 5-minute archive is a problem', () => {
  const have = all(); have.bars5m.delete('2026-10-07');
  const r = assess(base({ have }));
  assert.strictEqual(r.status, 'bad');
  assert.ok(r.messages.some(m => m.level === 'bad' && /5-minute archive for 2026-10-07/.test(m.text)));
  assert.strictEqual(r.rows.find(x => x.day === '2026-10-07').bars5m, 'missing');
});

test("today's archive is pending until 16:30, then a problem", () => {
  const have = all(); have.bars5m.delete('2026-10-08'); have.candles.delete('2026-10-08');
  const early = assess(base({ have, now: at('2026-10-08', '16:00') }));
  assert.strictEqual(early.rows.find(x => x.day === '2026-10-08').bars5m, 'pending');
  assert.ok(!codes(early).some(c => c.startsWith('missing')));
  const late = assess(base({ have, now: at('2026-10-08', '16:31') }));
  assert.strictEqual(late.status, 'bad');
  assert.ok(codes(late).includes('missing-2026-10-08'));
});

test('days before a kind of data was kept are not flagged', () => {
  const have = { dayRecord: new Set(DAYS), candles: new Set(DAYS), bars5m: new Set(DAYS) };
  const r = assess(base({ tradingDays: ['2026-09-29', ...DAYS], have }));
  const row = r.rows.find(x => x.day === '2026-09-29');
  assert.deepStrictEqual([row.dayRecord, row.candles, row.bars5m], ['n/a', 'n/a', 'n/a']);
  assert.strictEqual(r.status, 'ok');
});

test('the 5-minute archive only counts from 5 October', () => {
  const have = all(); have.bars5m = new Set(DAYS.slice(1)); // 5 Oct missing is a problem...
  assert.strictEqual(assess(base({ have })).status, 'bad');
  const withOct1 = new Set(['2026-10-01', ...DAYS]);
  const r2 = assess(base({ tradingDays: ['2026-10-01', ...DAYS], have: { dayRecord: withOct1, candles: withOct1, bars5m: new Set(DAYS) } })); // ...1 Oct has no 5-minute archive and is fine
  assert.strictEqual(r2.rows[0].bars5m, 'n/a'); assert.strictEqual(r2.status, 'ok');
});

test('heartbeat during market hours: warn after 5 minutes, bad after 15', () => {
  const now = at('2026-10-08', '11:00');
  const w = assess(base({ now, engine: { lastSaveAt: now - 7 * 60e3, outbox: 0 } }));
  assert.ok(codes(w).includes('save-slow')); assert.strictEqual(w.status, 'warn');
  const b = assess(base({ now, engine: { lastSaveAt: now - 20 * 60e3, outbox: 0 } }));
  assert.ok(codes(b).includes('not-saving')); assert.strictEqual(b.status, 'bad');
});

test('no heartbeat alarm right after a restart, at night, on weekends, or on a non-trading day', () => {
  const noSave = { lastSaveAt: null, outbox: 0 };
  assert.ok(!codes(assess(base({ now: at('2026-10-08', '11:00'), uptimeMs: 60e3, engine: noSave }))).includes('not-saving'));
  assert.ok(!codes(assess(base({ now: at('2026-10-08', '20:00'), engine: noSave }))).includes('not-saving'));
  assert.ok(!codes(assess(base({ now: at('2026-10-10', '11:00'), engine: noSave }))).includes('not-saving')); // Saturday
  assert.ok(!codes(assess(base({ now: at('2026-10-08', '11:00'), tradingToday: false, engine: noSave }))).includes('not-saving'));
});

test('a recent failed save is a problem until a later save succeeds', () => {
  const now = at('2026-10-08', '11:00');
  const bad = assess(base({ now, engine: { lastSaveAt: now - 120e3, lastSaveError: 'HTTP 503', lastSaveErrorAt: now - 30e3, outbox: 0 } }));
  assert.ok(codes(bad).includes('save-failed'));
  const ok = assess(base({ now, engine: { lastSaveAt: now - 5e3, lastSaveError: null, lastSaveErrorAt: now - 30e3, outbox: 0 } }));
  assert.ok(!codes(ok).includes('save-failed'));
});

test('database fullness and an unreachable database', () => {
  assert.ok(codes(assess(base({ redis: { ok: true, usedMb: 59, maxMb: 64 } }))).includes('redis-full'));
  assert.ok(codes(assess(base({ redis: { ok: true, usedMb: 48, maxMb: 64 } }))).includes('redis-filling'));
  assert.strictEqual(assess(base({ redis: { ok: true, usedMb: 20, maxMb: 64 } })).status, 'ok');
  const down = assess(base({ redis: { ok: false, error: 'timeout' } }));
  assert.strictEqual(down.status, 'bad'); assert.ok(codes(down).includes('redis-down'));
});

test('backup age: none, 10 days, 40 days, and one that finished with warnings', () => {
  const now = at('2026-10-08', '17:00');
  assert.ok(codes(assess(base({ backup: null }))).includes('no-backup'));
  assert.strictEqual(assess(base({ backup: { at: now - 10 * 86400e3 } })).status, 'warn');
  assert.strictEqual(assess(base({ backup: { at: now - 40 * 86400e3 } })).status, 'bad');
  assert.ok(codes(assess(base({ backup: { at: now - 3600e3, warnings: ['list was reset'] } }))).includes('backup-warnings'));
});

test('if the trading calendar is unknown, a missing day is only a warning', () => {
  const have = all(); have.candles.delete('2026-10-06');
  const r = assess(base({ have, tradingDaysKnown: false }));
  assert.strictEqual(r.status, 'warn'); assert.ok(/holiday/.test(r.messages[0].text));
});

test('log records waiting to be written are reported', () => {
  const now = at('2026-10-08', '17:00');
  assert.ok(codes(assess(base({ engine: { lastSaveAt: now - 5e3, lastFlushAt: now - 20 * 60e3, outbox: 3 } }))).includes('log-backlog'));
  assert.ok(!codes(assess(base({ engine: { lastSaveAt: now - 5e3, lastFlushAt: now - 60e3, outbox: 3 } }))).includes('log-backlog'));
});

test('dayOf reads the trading day from stored items', () => {
  assert.strictEqual(dayOf({ day: '2026-10-07' }), '2026-10-07');
  assert.strictEqual(dayOf({ t: Date.UTC(2026, 9, 7, 4, 5) }), '2026-10-07');
  assert.strictEqual(dayOf(null), null);
});
