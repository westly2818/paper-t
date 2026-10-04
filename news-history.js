// Network layer that lets the REAL news check (lib/gemini.js checkNews) run on past dates.
//  - Google News RSS: the live query `"Company" when:2d` becomes `"Company" after:<day-2> before:<day+1>`, so only headlines
//    from that window come back; the unchanged live code then applies its 36-hour window, company-name matching and de-duplication.
//  - Gemini: the exact live prompt is sent; every answer is cached on disk by prompt, so re-running a backtest is free and repeatable.
// Everything is cached under data/news-cache. A cache miss for Gemini needs GEMINI_API_KEY (or LLM_API_KEY_FREE) in the environment.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, 'data', 'news-cache');
const sha = s => crypto.createHash('sha1').update(s).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let currentDay = null;
const setDay = d => { currentDay = d; };
const blockedUntil = {}; // model URL -> time until which we do not call it again after a quota error
const stats = { rssCached: 0, rssFetched: 0, geminiCached: 0, geminiFetched: 0 };

let chain = Promise.resolve();
const lastCall = { rss: 0, gemini: 0 };
const throttle = (kind, gapMs) => { const p = chain.then(async () => { const w = lastCall[kind] + gapMs - Date.now(); if (w > 0) await sleep(w); lastCall[kind] = Date.now(); }); chain = p.catch(() => {}); return p; };

const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => body, json: async () => JSON.parse(body) });
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);

async function historicalFetch(url, opts = {}) {
  const u = String(url);
  if (u.includes('news.google.com/rss/search')) {
    if (!currentDay) throw new Error('news-history: setDay() was not called');
    const uo = new URL(u);
    const q0 = uo.searchParams.get('q');
    const m = /\bwhen:(\d+)d\b/.exec(q0);
    const n = m ? +m[1] : 2, d0 = Date.parse(currentDay + 'T00:00:00Z');
    const q = q0.replace(/\s*when:\d+d/, '') + ` after:${isoDay(d0 - n * 86400e3)} before:${isoDay(d0 + 86400e3)}`;
    uo.searchParams.set('q', q);
    const f = path.join(ROOT, 'rss', sha(q) + '.xml');
    if (fs.existsSync(f)) { stats.rssCached++; return resp(200, fs.readFileSync(f, 'utf8')); }
    for (let attempt = 0; attempt < 5; attempt++) {
      await throttle('rss', 450);
      const r = await fetch(uo, { headers: { 'User-Agent': 'Mozilla/5.0 (paper-trader)' }, signal: AbortSignal.timeout(20000) });
      if (r.status === 429 || r.status >= 500) { await sleep(5000 * (attempt + 1)); continue; }
      const body = await r.text();
      if (!r.ok) return resp(r.status, body);
      fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body);
      stats.rssFetched++;
      return resp(200, body);
    }
    return resp(503, '');
  }
  if (u.includes('generativelanguage.googleapis.com')) {
    const body = String(opts.body || '');
    const f = path.join(ROOT, 'gemini', sha(u + body) + '.json');
    if (process.env.NEWS_FAKE_GEMINI === '1') { // plumbing test only: clears every stock that has a headline, never cached
      const syms = [...new Set([...body.matchAll(/\[([A-Z0-9&-]+)\] /g)].map(x => x[1]))];
      const out = { market: { risk: 'normal', summary: 'test', evidence: [] }, stocks: syms.map(x => ({ symbol: x, trade_block: false, risk: 'low', reason: 'test: no adverse headline', evidence: [x + '#1'] })) };
      return resp(200, JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] }));
    }
    if (fs.existsSync(f)) { stats.geminiCached++; return resp(200, fs.readFileSync(f, 'utf8')); }
    if (!(opts.headers && opts.headers['x-goog-api-key']) || opts.headers['x-goog-api-key'] === 'cached-only') throw new Error('No Gemini answer cached for this prompt and no GEMINI_API_KEY is set');
    if ((blockedUntil[u] || 0) > Date.now()) return resp(429, '{"error":{"message":"model quota exhausted (remembered for this run)"}}');
    await throttle('gemini', 4500);
    const r = await fetch(u, opts);
    if (r.status === 429) { blockedUntil[u] = Date.now() + 15 * 60000; return resp(429, await r.text()); }
    const text = await r.text();
    if (r.ok) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); stats.geminiFetched++; }
    return resp(r.status, text);
  }
  return fetch(url, opts);
}

module.exports = { historicalFetch, setDay, stats };
