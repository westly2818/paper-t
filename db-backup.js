// Copies everything the apps keep in Upstash Redis to local files, and tells you how full the database is.
//   node --env-file=.env db-backup.js [--out data/db-backup]
// Run it whenever you like (weekly is plenty). Safe to repeat: dated blobs (price archives, candles) that are already on disk
// are not downloaded again; lists (trades, signals, days, scans...) and state keys are refreshed each time, so the local copy
// is always a full, readable record that your analysis scripts can use without the database.
// Files: <out>/<key with ":" turned into "__">.json  (lists are a JSON array, strings keep their text; base64 gzip blobs stay as text).
const fs = require('fs');
const path = require('path');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', path.join('data', 'db-backup'));
const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
if (!url) { console.error('Set UPSTASH_REDIS_REST_URL/TOKEN (run with: node --env-file=.env db-backup.js)'); process.exit(1); }
const call = async cmd => {
  const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: JSON.stringify(cmd) });
  const j = await r.json(); if (j.error) throw new Error(j.error); return j.result;
};
const fileOf = key => path.join(OUT, key.replace(/:/g, '__') + '.json');
const isDated = key => /:(bars5m|candles):\d{4}-\d{2}-\d{2}$/.test(key);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const keys = (await call(['KEYS', '*'])).sort();
  let fetched = 0, skipped = 0, bytes = 0;
  for (const key of keys) {
    const f = fileOf(key);
    if (isDated(key) && fs.existsSync(f)) { skipped++; continue; }
    const type = await call(['TYPE', key]);
    let body;
    if (type === 'list') body = JSON.stringify(await call(['LRANGE', key, 0, -1]));
    else if (type === 'string') body = JSON.stringify({ key, value: await call(['GET', key]) });
    else { console.log('  skipped (type ' + type + '): ' + key); continue; }
    fs.writeFileSync(f, body); bytes += body.length; fetched++;
  }
  console.log(`${keys.length} keys in the database: ${fetched} saved to ${OUT}, ${skipped} dated archives already on disk (${(bytes / 1024).toFixed(0)} KB written).`);

  // how full is it, and how long until it is full at the current growth
  const info = String(await call(['INFO']));
  const used = +(/used_memory:(\d+)/.exec(info) || [])[1], max = +(/maxmemory:(\d+)/.exec(info) || [])[1];
  const dated = keys.filter(isDated), daysCovered = new Set(dated.map(k => k.slice(-10))).size;
  let datedBytes = 0; for (const k of dated) datedBytes += (await call(['MEMORY', 'USAGE', k])) || 0;
  const perDay = daysCovered ? datedBytes / daysCovered + 60 * 1024 : null;   // archive per day plus about 60 KB of day record, signals and scans
  console.log(`\nDatabase memory: ${(used / 1048576).toFixed(2)} MB used` + (max ? ` of ${(max / 1048576).toFixed(0)} MB` : ''));
  if (perDay && max) console.log(`Growth about ${(perDay / 1024).toFixed(0)} KB a trading day, so it is full in about ${Math.floor((max - used) / perDay)} more trading days (${((max - used) / perDay / 250).toFixed(1)} years).`);
  console.log('Local copy is complete: your analysis can run from ' + OUT + ' even if the database is cleared or full.');
})().catch(e => { console.error('BACKUP ERROR', e.message); process.exit(1); });
