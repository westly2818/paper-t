// Fetches recent headlines ourselves (Google News RSS, free, every item has an exact publish time),
// so the time window is enforced in code and every source shown to you really came from a fetch.
const dec = s => String(s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
const tag = (x, t) => { const m = x.match(new RegExp('<' + t + '[^>]*>([\\s\\S]*?)</' + t + '>')); return m ? dec(m[1]) : ''; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Words that do not identify a company. A headline must contain one of the remaining words (or the NSE symbol).
const GENERIC = new Set(['limited', 'ltd', 'india', 'indian', 'corporation', 'corp', 'industries', 'company', 'and', 'the', 'bank', 'finance', 'financial', 'services', 'holdings', 'enterprises', 'international', 'global', 'power', 'energy', 'motors', 'new']);

const stripLegal = name => String(name || '').replace(/\b(limited|ltd|pvt|private)\b\.?/gi, '').replace(/\s+/g, ' ').trim();

function nameTokens(name, symbol) {
  const toks = stripLegal(name).toLowerCase().replace(/[^a-z0-9 &]/g, ' ').split(/\s+/).filter(t => t.length > 2 && !GENERIC.has(t));
  return [...new Set([...toks, String(symbol).toLowerCase()])];
}

async function rss(query, fetchImpl) {
  const url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(query) + '&hl=en-IN&gl=IN&ceid=IN:en';
  const r = await fetchImpl(url, { headers: { 'User-Agent': 'Mozilla/5.0 (paper-trader)' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`news feed HTTP ${r.status}`);
  const x = await r.text();
  if (!/<rss|<channel/.test(x)) throw new Error('news feed returned no feed');
  return [...x.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => {
    const t = Date.parse(tag(m[1], 'pubDate'));
    return { title: tag(m[1], 'title'), url: tag(m[1], 'link'), source: tag(m[1], 'source'), publishedMs: isFinite(t) ? t : null };
  });
}

function windowFilter(items, windowHours, nowMs, slackMs = 3600e3) {
  const seen = new Set();
  return items
    .filter(i => i.publishedMs && nowMs - i.publishedMs <= windowHours * 3600e3 && i.publishedMs <= nowMs + slackMs)
    .filter(i => { const k = i.title.toLowerCase().slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => b.publishedMs - a.publishedMs);
}

// One stock. Throws on a network or feed failure (the caller marks the stock unverified).
async function stockHeadlines({ symbol, name, windowHours, nowMs, max = 12, fetchImpl = fetch, slackMs }) {
  const days = Math.max(1, Math.ceil(windowHours / 24));
  const query = `"${stripLegal(name) || symbol}" when:${days}d`;
  const all = await rss(query, fetchImpl);
  const toks = nameTokens(name, symbol);
  const relevant = all.filter(i => toks.some(t => i.title.toLowerCase().includes(t)));
  const inWindow = windowFilter(relevant, windowHours, nowMs, slackMs);
  return { query, fetched: all.length, kept: inWindow.slice(0, max) };
}

async function marketHeadlines({ windowHours, nowMs, max = 14, fetchImpl = fetch }) {
  const all = [];
  for (const q of ['Sensex Nifty market today when:1d', 'RBI OR Fed OR Budget OR "F&O expiry" OR "global markets" India stocks when:1d']) all.push(...await rss(q, fetchImpl));
  return windowFilter(all, Math.min(windowHours, 24), nowMs).slice(0, max);
}

// Fetch for many stocks, a few at a time. Returns { SYMBOL: { ok, query, fetched, kept } | { ok:false, error } }.
async function allHeadlines({ symbols, names, windowHours, nowMs, fetchImpl = fetch, concurrency = 3, slackMs }) {
  const out = {};
  let i = 0;
  const worker = async () => {
    while (i < symbols.length) {
      const sym = symbols[i++];
      try { out[sym] = { ok: true, ...(await stockHeadlines({ symbol: sym, name: names[sym], windowHours, nowMs, fetchImpl, slackMs })) }; }
      catch (e) { out[sym] = { ok: false, error: e.message }; }
      await sleep(150);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

module.exports = { allHeadlines, marketHeadlines, stockHeadlines, nameTokens, windowFilter, stripLegal };
