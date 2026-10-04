// A stock removed by the news check must be remembered (with its info) so its prices are saved and the day can be replayed offline.
const test = require('node:test');
const assert = require('node:assert');
const base = require('../config');
const { Engine } = require('../lib/engine');

test('news-avoided stock is added to the shadow list and never gets a tradable plan', () => {
  const cfg = { ...base, mode: 'demo', newsGuard: true };
  const eng = new Engine(cfg, {}, { now: () => 0 });
  const S = eng.S;
  const bad = { sym: 'BADCO', bias: 'bull', close: 100 }, good = { sym: 'GOODCO', bias: 'bull', close: 200 };
  S.day = '2026-01-05'; S.now = Date.UTC(2026, 0, 5, 3, 30);
  S.watch = { picked: [bad, good], backups: [], pool: [bad, good], news: {} };
  eng.applyNews({
    stocks: { BADCO: { block: true, reason: 'fraud probe', sources: [] }, GOODCO: { block: false, reason: 'nothing', sources: [] } },
    market: 'normal', source: 'test'
  });
  assert.deepStrictEqual(S.watch.shadow.map(x => x.sym), ['BADCO']);
  assert.strictEqual(S.watch.shadow[0].blockedBy, 'news');
  assert.strictEqual(S.watch.shadow[0].info.close, 100);
  assert.strictEqual(S.plans['BADCO'].status, 'skipped');
  assert.ok(!S.plans['GOODCO'] || S.plans['GOODCO'].status !== 'skipped');
});
