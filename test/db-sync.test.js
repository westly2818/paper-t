// db-sync against a fake Upstash REST server and a throwaway database on the local MongoDB (skipped if MongoDB is not running).
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { MongoClient } = require('mongodb');
const { sync, exportFiles, coverage, connect } = require('../db-sync');

const URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const quiet = () => {};

function fakeUpstash(store) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', c => (body += c)); req.on('end', () => {
      const cmd = JSON.parse(body); calls.push(cmd);
      const [op, a, b, c] = cmd; const v = store.get(a); let result = null;
      if (op === 'SCAN') result = ['0', [...store.keys()]];
      else if (op === 'TYPE') result = Array.isArray(v) ? 'list' : typeof v === 'string' ? 'string' : 'none';
      else if (op === 'LLEN') result = v.length;
      else if (op === 'LINDEX') result = v[b] ?? null;
      else if (op === 'LRANGE') result = v.slice(b, c + 1);
      else if (op === 'GET') result = v ?? null;
      else if (op === 'INFO') result = 'used_memory:1048576\r\nmaxmemory:67108864\r\n';
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ result }));
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

test('incremental sync copies only what is new, never re-fetches archives, and refuses to overwrite a reset list', async t => {
  const probe = new MongoClient(URI, { serverSelectionTimeoutMS: 2000 });
  try { await probe.connect(); } catch (e) { t.skip('MongoDB is not running'); return; }
  const dbName = 'papertrader_test_' + Date.now();
  const J = o => JSON.stringify(o);
  const gz1 = zlib.gzipSync(J({ SBIN: [[1, 2, 3]] })).toString('base64');
  const store = new Map([
    ['paper-trader:state:trades', [J({ day: '2026-10-05', sym: 'A', rMultiple: -1 }), J({ day: '2026-10-06', sym: 'B', rMultiple: 1.5 })]],
    ['paper-trader:state:days', [J({ day: '2026-10-05' })]],
    ['paper-trader:state:candles:2026-10-05', gz1],
    ['paper-trader:state', J({ equity: 100 })]
  ]);
  const up = await fakeUpstash(store);
  const base = { url: up.url, token: 'x', uri: URI, dbName, log: quiet };
  try {
    // ---- first sync: everything
    const s1 = await sync(base);
    assert.strictEqual(s1.listItems, 3); assert.strictEqual(s1.blobs, 1); assert.strictEqual(s1.kv, 1);
    const { client, db } = await connect(URI, dbName);
    let cov = await coverage(db);
    assert.strictEqual(cov.lists.find(l => l._id === 'paper-trader:state:trades').lastDay, '2026-10-06');
    assert.strictEqual(cov.blobs[0].lastDay, '2026-10-05');

    // ---- new data appears in Redis
    store.get('paper-trader:state:trades').push(J({ day: '2026-10-07', sym: 'C', rMultiple: -0.3 }));
    store.set('paper-trader:state:candles:2026-10-07', gz1);
    store.set('paper-trader:state', J({ equity: 250 }));
    up.calls.length = 0;
    const s2 = await sync(base);
    assert.strictEqual(s2.listItems, 1, 'only the one new trade is copied');
    assert.strictEqual(s2.blobs, 1, 'only the new day archive is copied');
    const lrange = up.calls.filter(c => c[0] === 'LRANGE' && c[1].endsWith(':trades'));
    assert.deepStrictEqual(lrange.map(c => c[2]), [2], 'LRANGE starts at the first item not stored locally');
    assert.ok(!up.calls.some(c => c[0] === 'GET' && c[1] === 'paper-trader:state:candles:2026-10-05'), 'the archive already stored is not downloaded again');
    assert.strictEqual((await db.collection('kv').findOne({ _id: 'paper-trader:state' })).parsed.equity, 250, 'state is refreshed');
    cov = await coverage(db);
    assert.strictEqual(cov.lists.find(l => l._id === 'paper-trader:state:trades').lastDay, '2026-10-07');

    // ---- nothing new: nothing copied
    const s3 = await sync(base);
    assert.strictEqual(s3.listItems, 0); assert.strictEqual(s3.blobs, 0);

    // ---- Redis list was reset: the local copy must survive
    store.set('paper-trader:state:days', []);
    const s4 = await sync(base);
    assert.strictEqual(s4.warnings.length, 1);
    assert.strictEqual(await db.collection('lists').countDocuments({ key: 'paper-trader:state:days' }), 1);

    // ---- an old item was rewritten in Redis: warn, keep local
    store.get('paper-trader:state:trades')[2] = J({ day: '2026-10-07', sym: 'CHANGED' });
    const s5 = await sync(base);
    assert.ok(s5.warnings.some(w => /differs/.test(w)));
    assert.strictEqual((await db.collection('lists').findOne({ key: 'paper-trader:state:trades', idx: 2 })).doc.sym, 'C');

    // ---- export gives files the analysis scripts can read
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dbsync-'));
    await exportFiles({ uri: URI, dbName, out, log: quiet });
    const lines = fs.readFileSync(path.join(out, 'trades.jsonl'), 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 3); assert.strictEqual(JSON.parse(lines[2]).sym, 'C');
    assert.deepStrictEqual(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(out, 'candles-2026-10-05.json.gz'))).toString()), { SBIN: [[1, 2, 3]] });
    await client.close();
  } finally {
    await probe.db(dbName).dropDatabase();
    await probe.close(); up.server.close();
  }
});
