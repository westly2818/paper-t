// Download historical candles from Fyers into CSV files (time_utc,open,high,low,close,volume).
//   node --env-file=.env fyers-download.js --months 12 --res 1 --out data/fyers-1m --symbols data/tv-symbols.txt
//   node --env-file=.env fyers-download.js --months 1 --symbols NIFTY,RELIANCE      (quick test)
// Needs a token from fyers-login.js. Skips files that already exist, so it can be re-run after an interruption.
// Symbols: plain NSE names as in config.js. NIFTY and INDIAVIX map to the Fyers index symbols.
const fs = require('fs');
const path = require('path');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const months = +arg('months', 12), res = arg('res', '1'), out = arg('out', 'data/fyers-' + res + 'm'), symArg = arg('symbols', 'data/tv-symbols.txt');
const tokenFile = path.join(__dirname, 'data', 'fyers-token.json');
if (!fs.existsSync(tokenFile)) { console.error('No token. Run: node --env-file=.env fyers-login.js'); process.exit(1); }
const { appId, access_token } = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
const symbols = fs.existsSync(symArg) ? fs.readFileSync(symArg, 'utf8').split(/\s+/).filter(Boolean) : symArg.split(',');
fs.mkdirSync(out, { recursive: true });

const SPECIAL = { NIFTY: 'NSE:NIFTY50-INDEX', INDIAVIX: 'NSE:INDIAVIX-INDEX' };
const fy = s => SPECIAL[s] || `NSE:${s}-EQ`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const iso = d => d.toISOString().slice(0, 10);
const CHUNK_DAYS = res === 'D' ? 360 : 95;   // Fyers allows about 100 days per intraday request

async function chunk(sym, from, to) {
  const url = 'https://api-t1.fyers.in/data/history?' + new URLSearchParams({ symbol: fy(sym), resolution: res, date_format: '1', range_from: iso(from), range_to: iso(to), cont_flag: '1' });
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url, { headers: { Authorization: `${appId}:${access_token}` } });
    if (r.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
    const j = await r.json().catch(() => ({}));
    if (j.s === 'ok') return j.candles || [];
    if (j.s === 'no_data') return [];
    if (j.code === -16 || j.code === -15 || /token/i.test(j.message || '')) { console.error('Token rejected: run fyers-login.js again.', j.message); process.exit(1); }
    throw new Error(j.message || JSON.stringify(j));
  }
  throw new Error('rate limited');
}

(async () => {
  const end = new Date(), start = new Date(end.getTime() - months * 30.5 * 86400000);
  console.log(`${symbols.length} symbols, resolution ${res}, ${iso(start)} to ${iso(end)}, into ${out}`);
  let ok = 0, bad = [];
  for (const sym of symbols) {
    const file = path.join(out, sym.replace(/[^A-Za-z0-9_&-]/g, '_') + '.csv');
    if (fs.existsSync(file)) { ok++; continue; }
    try {
      const rows = [];
      for (let a = new Date(start); a < end; a = new Date(a.getTime() + CHUNK_DAYS * 86400000)) {
        const b = new Date(Math.min(end.getTime(), a.getTime() + (CHUNK_DAYS - 1) * 86400000));
        rows.push(...await chunk(sym, a, b));
        await sleep(400);   // stays under the 200 requests/minute limit
      }
      const seen = new Set(), clean = rows.filter(r => !seen.has(r[0]) && seen.add(r[0])).sort((x, y) => x[0] - y[0]);
      if (!clean.length) throw new Error('no data');
      fs.writeFileSync(file, 'time_utc,open,high,low,close,volume\n' + clean.map(r => [new Date(r[0] * 1000).toISOString(), r[1], r[2], r[3], r[4], r[5]].join(',')).join('\n') + '\n');
      ok++; console.log(`${sym}: ${clean.length} bars, ${new Date(clean[0][0] * 1000).toISOString().slice(0, 10)} to ${new Date(clean[clean.length - 1][0] * 1000).toISOString().slice(0, 10)}`);
    } catch (e) { bad.push(sym); console.log(`${sym}: failed (${e.message})`); }
  }
  console.log(`\nDone: ${ok} ok, ${bad.length} failed${bad.length ? ': ' + bad.join(' ') : ''}`);
})();
