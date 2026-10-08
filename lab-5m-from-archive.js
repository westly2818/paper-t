// Builds the 5-minute files the strategy lab (intraday-lab.js) reads, from your own live archive.
//   node lab-5m-from-archive.js [--out data/lab-5m-recent] [--history data/fyers-1m] [--since 2026-08-14]
// Source of the bars: the daily 5-minute archive of all 202 symbols that the live bot saves (bars5m:<day>), read from the local
// MongoDB that db-sync.js fills. For days before the archive started, the optional --history folder of 1-minute Fyers files is
// aggregated to 5 minutes, so the lab's volume baseline (it needs about 10 earlier sessions) has something to start from.
// Run db-sync.js first so the newest days are in MongoDB.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { MongoClient } = require('mongodb');

const IST = 5.5 * 3600e3;
const mapSym = s => (s === '^NSEI' ? 'NIFTY' : s === '^INDIAVIX' ? 'INDIAVIX' : s);

async function build({ out, history, since = '2026-08-14', uri = 'mongodb://127.0.0.1:27017', dbName = 'paper_trader', log = console.log }) {
  const FROM = Date.parse(since + 'T00:00:00Z');
  fs.mkdirSync(out, { recursive: true });
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 }); await client.connect();
  try {
    const archive = {}, days = [];
    const blobs = await client.db(dbName).collection('blobs').find({ _id: /:bars5m:/ }).sort({ _id: 1 }).toArray();
    for (const b of blobs) {
      const j = JSON.parse(zlib.gunzipSync(Buffer.from(b.data.buffer)).toString()); days.push(b.day);
      for (const [sym, bars] of Object.entries(j)) (archive[mapSym(sym)] = archive[mapSym(sym)] || []).push(...bars);
    }
    if (!blobs.length) throw new Error('No 5-minute archive in MongoDB yet. Run: node --env-file=.env db-sync.js');
    log(`archive days in MongoDB: ${days[0]} to ${days[days.length - 1]} (${days.length})`);
    const syms = new Set(Object.keys(archive));
    if (history && fs.existsSync(history)) for (const f of fs.readdirSync(history)) if (f.endsWith('.csv')) syms.add(f.slice(0, -4));
    let n = 0;
    for (const sym of syms) {
      const bars = new Map();
      const hf = history && path.join(history, sym + '.csv');
      if (hf && fs.existsSync(hf)) {
        for (const l of fs.readFileSync(hf, 'utf8').trim().split('\n').slice(1)) {
          const r = l.split(','), t = Date.parse(r[0]); if (t < FROM) continue;
          const m = new Date(t + IST), mod = m.getUTCHours() * 60 + m.getUTCMinutes(), start = t - ((mod - 555) % 5) * 60000;
          const o = +r[1], h = +r[2], lo = +r[3], c = +r[4], v = +r[5], cur = bars.get(start);
          if (!cur) bars.set(start, [start, o, h, lo, c, v]); else { cur[2] = Math.max(cur[2], h); cur[3] = Math.min(cur[3], lo); cur[4] = c; cur[5] += v; }
        }
      }
      const firstArchive = (archive[sym] || []).reduce((a, b) => Math.min(a, b[0]), Infinity);
      for (const k of [...bars.keys()]) if (k >= firstArchive) bars.delete(k);        // the live archive wins where both exist
      for (const b of archive[sym] || []) bars.set(b[0], b);
      const rows = [...bars.values()].sort((a, b) => a[0] - b[0]);
      if (!rows.length) continue;
      fs.writeFileSync(path.join(out, sym + '.csv'), 'time_utc,open,high,low,close,volume\n' + rows.map(b => [new Date(b[0]).toISOString(), b[1], b[2], b[3], b[4], b[5]].join(',')).join('\n') + '\n');
      n++;
    }
    log(`wrote ${n} files to ${out}`);
    return { files: n, days };
  } finally { await client.close(); }
}

module.exports = { build };

if (require.main === module) {
  const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
  build({ out: arg('out', path.join('data', 'lab-5m-recent')), history: arg('history', fs.existsSync(path.join('data', 'fyers-1m')) ? path.join('data', 'fyers-1m') : null), since: arg('since', '2026-08-14') })
    .catch(e => { console.error('ERROR:', e.message); process.exit(1); });
}
