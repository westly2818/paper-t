// Incremental backup of everything in Upstash Redis into your local MongoDB.
//   node --env-file=.env db-sync.js                 sync: checks what MongoDB already has, then copies only what is new
//   node --env-file=.env db-sync.js --status        show what MongoDB has and how far it goes (no Redis needed)
//   node --env-file=.env db-sync.js --export data/db-export
//                                                   write the stored data out as files the analysis scripts read
//                                                   (trades.jsonl, days.jsonl, signals.jsonl, candles-<day>.json.gz ...), e.g.
//                                                   node strategies.js --dir data/db-export
//   node --env-file=.env db-sync.js --full          ignore what is stored and re-copy everything (rarely needed)
// .env needs UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (the same two values the Render service uses).
// Optional: MONGODB_URI (default mongodb://127.0.0.1:27017) and MONGODB_DB (default paper_trader).
// Nothing is ever deleted from Redis or from MongoDB. Needs the `mongodb` driver: run `npm install` once in this folder.
//
// How "incremental" works, per kind of key:
//   list (trades, days, signals, scans ...)  Redis lists only grow. MongoDB remembers how many items it has (n); the script
//        copies items n..end only, after checking item n-1 is still the same item (so a reset list is noticed, not overwritten).
//   dated blob (price archives candles:<day>, bars5m:<day>)  never change once written: fetched once, skipped afterwards.
//   other string (state, settings, swing and V5 books ...)   small and changing: the latest value replaces the old one.
// Collections: lists {key, idx, day, raw, doc}, blobs {_id: key, day, bytes, data}, kv {_id: key, value, parsed}, sync_log.
const fs = require('fs');
const path = require('path');
const { MongoClient, Binary } = require('mongodb');

const DATED = /:(bars5m|candles):(\d{4}-\d{2}-\d{2})$/;
const IST = 5.5 * 3600e3;
const ymd = ms => new Date(ms + IST).toISOString().slice(0, 10);
const dayOf = rec => {      // the trading day a list item belongs to, for the "data until" report
  if (!rec || typeof rec !== 'object') return null;
  if (typeof rec.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rec.day)) return rec.day;
  for (const k of ['t', 'at', 'decidedAt', 'closedAt', 'tOut', 'tIn']) if (Number.isFinite(rec[k]) && rec[k] > 1e12) return ymd(rec[k]);
  return null;
};
const parse = s => { try { return JSON.parse(s); } catch (e) { return null; } };

async function connect(uri, dbName) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const db = client.db(dbName);
  await db.collection('lists').createIndex({ key: 1, idx: 1 }, { unique: true });
  await db.collection('lists').createIndex({ key: 1, day: 1 });
  return { client, db };
}

// ---------- what the local database already has ----------
async function coverage(db) {
  const lists = await db.collection('lists').aggregate([
    { $group: { _id: '$key', n: { $sum: 1 }, maxIdx: { $max: '$idx' }, firstDay: { $min: '$day' }, lastDay: { $max: '$day' } } }, { $sort: { _id: 1 } }]).toArray();
  const blobMeta = await db.collection('blobs').find({}, { projection: { data: 0 } }).toArray();
  const groups = {};
  for (const b of blobMeta) { const p = b._id.replace(/:\d{4}-\d{2}-\d{2}$/, ''); const g = groups[p] || (groups[p] = { prefix: p, n: 0, firstDay: b.day, lastDay: b.day, bytes: 0 }); g.n++; g.bytes += b.bytes || 0; if (b.day < g.firstDay) g.firstDay = b.day; if (b.day > g.lastDay) g.lastDay = b.day; }
  const kvN = await db.collection('kv').countDocuments();
  const kvLast = (await db.collection('kv').find({}, { projection: { fetched_at: 1 } }).sort({ fetched_at: -1 }).limit(1).toArray())[0];
  const last = (await db.collection('sync_log').find().sort({ _id: -1 }).limit(1).toArray())[0];
  return { lists, blobs: Object.values(groups).sort((a, b) => (a.prefix < b.prefix ? -1 : 1)), kv: { n: kvN, last: kvLast && kvLast.fetched_at }, last };
}
function printCoverage(c, title, log = console.log) {
  log(title);
  if (!c.lists.length && !c.blobs.length && !c.kv.n) { log('  (empty: this will be a full copy)'); return; }
  for (const l of c.lists) log(`  list  ${l._id.padEnd(44)} ${String(l.n).padStart(6)} items   data until ${l.lastDay || 'n/a'}${l.firstDay ? ' (from ' + l.firstDay + ')' : ''}`);
  for (const b of c.blobs) log(`  blob  ${b.prefix.padEnd(44)} ${String(b.n).padStart(6)} days    data until ${b.lastDay}   (from ${b.firstDay}, ${(b.bytes / 1048576).toFixed(1)} MB)`);
  log(`  state ${String(c.kv.n).padStart(3)} keys, last refreshed ${c.kv.last || 'never'}`);
  if (c.last) log(`  last sync finished ${c.last.finished_at}`);
}

// ---------- the sync ----------
async function sync({ url, token, uri = 'mongodb://127.0.0.1:27017', dbName = 'paper_trader', full = false, log = console.log, pageSize = 500 }) {
  const call = async cmd => {
    const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: JSON.stringify(cmd), signal: AbortSignal.timeout(30000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(`${cmd[0]} ${cmd[1] || ''}: ${j.error || 'HTTP ' + r.status}`);
    return j.result;
  };
  const { client, db } = await connect(uri, dbName);
  try {
    const startedAt = new Date().toISOString();
    printCoverage(await coverage(db), `MongoDB ${dbName} before this sync:`, log);

    const keys = []; let cursor = '0';        // SCAN, so it also works on a big database
    do { const [next, batch] = await call(['SCAN', cursor, 'COUNT', 500]); cursor = String(next); keys.push(...batch); } while (cursor !== '0');
    keys.sort();
    const stats = { keys: keys.length, listItems: 0, blobs: 0, kv: 0, warnings: [] };
    const lists = db.collection('lists'), blobs = db.collection('blobs'), kv = db.collection('kv');
    const warn = w => { stats.warnings.push(w); log('  WARNING ' + w); };

    for (const key of keys) {
      const type = await call(['TYPE', key]);
      if (type === 'list') {
        const remoteLen = Number(await call(['LLEN', key]));
        const stored = await lists.aggregate([{ $match: { key } }, { $group: { _id: null, n: { $sum: 1 }, maxIdx: { $max: '$idx' } } }]).toArray();
        let have = full ? 0 : (stored[0] ? stored[0].n : 0);
        if (!full && stored[0] && stored[0].maxIdx + 1 !== stored[0].n) { warn(`${key}: the local copy has gaps (${stored[0].n} items, highest index ${stored[0].maxIdx}). Run with --full to re-copy it.`); continue; }
        if (have > remoteLen) { warn(`${key}: Redis has ${remoteLen} items but the local copy has ${have}. Redis was trimmed or reset; the local copy is kept untouched (run with --full to re-copy).`); continue; }
        if (have > 0) {                      // the item just before the new ones must still be the same item
          const remoteLast = await call(['LINDEX', key, have - 1]), local = await lists.findOne({ key, idx: have - 1 }, { projection: { raw: 1 } });
          if (!local || remoteLast !== local.raw) { warn(`${key}: item ${have - 1} differs from what is stored locally, so this list was changed in Redis. Local copy kept; run with --full to re-copy.`); continue; }
        }
        let added = 0;
        while (have < remoteLen) {
          const items = await call(['LRANGE', key, have, Math.min(remoteLen, have + pageSize) - 1]);
          if (!items.length) break;
          const docs = items.map((raw, k) => { const doc = parse(raw); return { key, idx: have + k, day: dayOf(doc), raw, doc }; });
          if (full) await lists.bulkWrite(docs.map(d => ({ replaceOne: { filter: { key: d.key, idx: d.idx }, replacement: d, upsert: true } })));
          else await lists.insertMany(docs, { ordered: true });
          have += items.length; added += items.length;
        }
        if (added) log(`  list  ${key}: +${added} new items (now ${have})`);
        stats.listItems += added;
      } else if (type === 'string') {
        const m = DATED.exec(key);
        if (m) {
          if (!full && await blobs.findOne({ _id: key }, { projection: { _id: 1 } })) continue;       // dated archives never change
          const data = await call(['GET', key]);
          if (data == null) continue;
          const gz = Buffer.from(data, 'base64');
          await blobs.replaceOne({ _id: key }, { _id: key, day: m[2], bytes: gz.length, data: new Binary(gz), fetched_at: new Date().toISOString() }, { upsert: true });
          stats.blobs++; log(`  blob  ${key} (${(gz.length / 1024).toFixed(0)} KB)`);
        } else {
          const value = await call(['GET', key]);
          await kv.replaceOne({ _id: key }, { _id: key, value, parsed: parse(value), fetched_at: new Date().toISOString() }, { upsert: true });
          stats.kv++;
        }
      } else log(`  skipped ${key} (type ${type})`);
    }

    let usedMb = null;
    try {
      const info = String(await call(['INFO'])), used = +(/used_memory:(\d+)/.exec(info) || [])[1], max = +(/maxmemory:(\d+)/.exec(info) || [])[1];
      usedMb = used / 1048576;
      log(`\nRedis memory: ${usedMb.toFixed(2)} MB used${max ? ` of ${(max / 1048576).toFixed(0)} MB` : ''}`);
    } catch (e) { /* INFO may be restricted; the backup itself is done */ }

    await db.collection('sync_log').insertOne({ started_at: startedAt, finished_at: new Date().toISOString(), keys_seen: stats.keys, list_items_added: stats.listItems, blobs_added: stats.blobs, kv_refreshed: stats.kv, redis_used_mb: usedMb, warnings: stats.warnings });
    log(`\nSync done: ${stats.keys} keys in Redis; added ${stats.listItems} list items, ${stats.blobs} new price archives, refreshed ${stats.kv} state keys${stats.warnings.length ? `; ${stats.warnings.length} warning(s) above` : ''}.`);
    printCoverage(await coverage(db), `\nMongoDB ${dbName} now:`, log);
    return stats;
  } finally { await client.close(); }
}

// ---------- export in the layout the analysis scripts expect ----------
async function exportFiles({ uri = 'mongodb://127.0.0.1:27017', dbName = 'paper_trader', out, log = console.log }) {
  const { client, db } = await connect(uri, dbName);
  try {
    fs.mkdirSync(out, { recursive: true });
    const names = new Map();
    for (const key of await db.collection('lists').distinct('key')) {
      const m = /^paper-trader:state:(.+)$/.exec(key);
      const name = m ? m[1] : key.replace(/:/g, '__');
      const rows = await db.collection('lists').find({ key }, { projection: { raw: 1 } }).sort({ idx: 1 }).toArray();
      fs.writeFileSync(path.join(out, name + '.jsonl'), rows.map(r => r.raw).join('\n') + '\n');
      names.set(name, rows.length);
    }
    let nb = 0;
    for await (const b of db.collection('blobs').find()) {
      const m = DATED.exec(b._id); if (!m) continue;
      fs.writeFileSync(path.join(out, `${m[1]}-${m[2]}.json.gz`), Buffer.from(b.data.buffer)); nb++;
    }
    log(`Exported ${names.size} lists (${[...names].map(([k, n]) => k + ' ' + n).join(', ')}) and ${nb} price archives to ${out}`);
    return { lists: names.size, blobs: nb };
  } finally { await client.close(); }
}

module.exports = { sync, exportFiles, connect, coverage, dayOf };

if (require.main === module) {
  const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
  const has = k => process.argv.includes('--' + k);
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017', dbName = process.env.MONGODB_DB || 'paper_trader';
  (async () => {
    if (has('status')) { const { client, db } = await connect(uri, dbName); try { printCoverage(await coverage(db), `MongoDB ${dbName} at ${uri}:`); } finally { await client.close(); } return; }
    if (has('export')) { await exportFiles({ uri, dbName, out: arg('export', path.join('data', 'db-export')) }); return; }
    const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) { console.error('Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in .env, then run: node --env-file=.env db-sync.js'); process.exit(1); }
    await sync({ url, token, uri, dbName, full: has('full') });
  })().catch(e => { console.error('SYNC ERROR:', e.message); process.exit(1); });
}
