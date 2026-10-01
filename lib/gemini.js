// Automated pre-market news check: WE fetch the headlines (lib/newsfeed.js), Gemini only classifies them.
// Why: Gemini's own Google Search grounding returns 429 (quota) on free keys. Classifying text we
// already hold needs no grounding quota, and it makes each guarantee checkable in code:
//  1. Real, current news: every verdict rests on headlines we fetched; none are taken from model memory.
//  2. Time window: only headlines published inside the window (exact RSS timestamps) are shown to the model.
//  3. Right company: each stock is searched by its full company name, headlines must mention it, and the
//     model is told the NSE symbol plus full name.
//  4. Structured verdict: a response schema forces JSON; evidence is a list of headline numbers that we
//     check against what we sent, and the sources shown are OUR headlines, never URLs the model typed.
//  5. Fail closed: no headlines, a feed error, a missing or invalid answer, or an API failure means
//     "unverified" (block = null) or a thrown error that sends the user to the manual flow. Never "safe".
const { allHeadlines, marketHeadlines } = require('./newsfeed');

const FALLBACK_MODELS = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.8-flash'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const modelList = cfg => [...new Set([cfg.geminiModel, ...FALLBACK_MODELS].filter(Boolean))];
const fmtDate = ms => new Date(ms).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    market: { type: 'OBJECT', properties: { risk: { type: 'STRING', enum: ['normal', 'elevated', 'high'] }, summary: { type: 'STRING' }, evidence: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['risk', 'summary', 'evidence'] },
    stocks: { type: 'ARRAY', items: { type: 'OBJECT', properties: { symbol: { type: 'STRING' }, trade_block: { type: 'BOOLEAN' }, risk: { type: 'STRING', enum: ['low', 'medium', 'high'] }, reason: { type: 'STRING' }, evidence: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['symbol', 'trade_block', 'risk', 'reason', 'evidence'] } }
  },
  required: ['market', 'stocks']
};

function buildPrompt({ symbols, names, headlines, market, windowHours, nowMs }) {
  const now = new Date(nowMs);
  const date = now.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full' });
  const blocks = symbols.map((s, n) => {
    const h = headlines[s].kept;
    return `[${s}] ${names[s] || 'NSE-listed company with this exact symbol'} (NSE: ${s})\n` + h.map((x, k) => `  ${s}#${k + 1} ${fmtDate(x.publishedMs)} | ${x.source || '?'} | ${x.title}`).join('\n');
  }).join('\n\n');
  const mk = market.map((x, k) => `  M#${k + 1} ${fmtDate(x.publishedMs)} | ${x.source || '?'} | ${x.title}`).join('\n') || '  (no market headlines)';
  return `You are a pre-market risk screener for an Indian same-day (intraday) equity trader. Today is ${date}. Below are headlines published in the last ${windowHours} hours. Use ONLY these headlines. Do not use memory or outside knowledge.

For EACH stock set trade_block = true when its headlines show concrete adverse or event risk for trading it today: results due today or yesterday, regulatory or legal action, fraud allegations, management exits or senior management change, large block or bulk deals, a rating downgrade, an F&O ban or trading restriction, a trading halt, ASM/GSM surveillance, a major accident or outage. Set trade_block = false only when the headlines show none of these. Ignore headlines about other companies, other exchanges, or generic market commentary. Positive news (order wins, upgrades, good sales numbers) does not block a stock.
risk is low, medium or high. reason is at most 25 words and must name what you saw. evidence lists the headline ids (like HAVELLS#2) that support your verdict. Give at least one id when trade_block is true.

Market risk for today, judged only from the market headlines: "normal" (nothing unusual), "elevated" (a notable event or stress: monthly F&O expiry, important US data, a moderate sell-off, FPI selling, rising yields or crude, a multi-week losing streak) or "high". Use "high" ONLY when the headlines show a major event happening TODAY (RBI or Fed rate decision, Union Budget, election result, a war or geopolitical shock) or a large one-day crash of more than 2% in the main indices. A long losing streak or general weakness alone is "elevated", never "high". Market-wide risk must NOT make you block individual stocks. Give evidence ids like M#1.

STOCK HEADLINES
${blocks}

MARKET HEADLINES
${mk}`;
}

async function callGemini({ prompt, key, models, fetchImpl = fetch, wait = sleep }) {
  let lastErr = new Error('No Gemini model responded');
  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    for (let attempt = 0; attempt < 3; attempt++) {
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA } }),
          signal: AbortSignal.timeout(90000)
        });
      } catch (e) { lastErr = new Error(`Gemini network error: ${e.message}`); await wait(2000 * (attempt + 1)); continue; }
      if (res.status === 404) { lastErr = new Error(`model ${model} not available`); break; }
      if (res.status === 429 || res.status >= 500) { lastErr = new Error(`Gemini HTTP ${res.status} (quota or server busy)`); await wait(attempt === 0 ? 2000 : 6000); continue; }
      if (!res.ok) { const t = await res.text(); throw new Error(`Gemini HTTP ${res.status}: ${t.slice(0, 200)}`); }
      const j = await res.json();
      const cand = j.candidates && j.candidates[0];
      const text = cand && cand.content && cand.content.parts ? cand.content.parts.filter(p => !p.thought).map(p => p.text || '').join('') : '';
      if (!text) { lastErr = new Error('Gemini returned an empty answer'); continue; }
      return { model, text };
    }
  }
  throw lastErr;
}

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : text;
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('Gemini answer was not JSON');
  try { return JSON.parse(raw.slice(a, b + 1)); } catch (e) { throw new Error('Gemini JSON did not parse: ' + e.message); }
}

// Evidence ids look like HAVELLS#2. Only ids that name THIS stock and exist in what we sent are kept.
function evidenceIds(list, prefix, count) {
  const out = [];
  for (const e of Array.isArray(list) ? list : []) {
    const m = /^\s*([A-Za-z0-9&-]+)#(\d+)\s*$/.exec(String(e));
    if (m && m[1].toUpperCase() === prefix.toUpperCase() && +m[2] >= 1 && +m[2] <= count && !out.includes(+m[2])) out.push(+m[2]);
  }
  return out;
}

// Turns the model's answer plus OUR headlines into the final per-stock result. block: true = avoid,
// false = checked and clear, null = unverified.
function validate(j, { symbols, headlines, market }) {
  const by = {};
  for (const s of (j && Array.isArray(j.stocks) ? j.stocks : [])) if (s && typeof s.symbol === 'string') by[s.symbol.toUpperCase()] = s;
  const stocks = {};
  for (const sym of symbols) {
    const h = headlines[sym];
    const base = { block: null, verified: false, risk: null, reason: '', sources: [], headlinesSeen: h && h.ok ? h.kept.length : 0 };
    if (!h || !h.ok) { stocks[sym] = { ...base, reason: `News fetch failed (${h ? h.error : 'not fetched'}), so this stock is unverified.` }; continue; }
    if (!h.kept.length) { stocks[sym] = { ...base, reason: `No headlines found in the window (${h.fetched} fetched, none matched the company), so this stock is unverified.` }; continue; }
    const v = by[sym];
    if (!v || typeof v.trade_block !== 'boolean') { stocks[sym] = { ...base, reason: 'The model gave no valid verdict for this stock.' }; continue; }
    const ids = evidenceIds(v.evidence, sym, h.kept.length);
    if (v.trade_block === true && !ids.length) { stocks[sym] = { ...base, reason: 'The model wanted to block this stock but cited no headline, so it is treated as unverified.' }; continue; }
    const cited = (ids.length ? ids : [1, 2, 3].filter(n => n <= h.kept.length)).slice(0, 4).map(n => h.kept[n - 1]);
    stocks[sym] = {
      block: v.trade_block, verified: true, risk: ['low', 'medium', 'high'].includes(v.risk) ? v.risk : null,
      reason: String(v.reason || '').slice(0, 220) || (v.trade_block ? 'Blocked.' : 'No adverse news in the headlines.'),
      sources: cited.map(x => ({ title: x.title.slice(0, 140), url: x.url, source: x.source, published: new Date(x.publishedMs).toISOString() })),
      headlinesSeen: h.kept.length
    };
  }
  const mj = (j && j.market) || {};
  const mids = evidenceIds(mj.evidence, 'M', market.length);
  const mrisk = ['normal', 'elevated', 'high'].includes(mj.risk) && market.length ? mj.risk : 'unknown';
  return {
    stocks,
    market: { risk: mrisk, summary: String(mj.summary || '').slice(0, 300), sources: mids.slice(0, 4).map(n => ({ title: market[n - 1].title.slice(0, 140), url: market[n - 1].url, source: market[n - 1].source, published: new Date(market[n - 1].publishedMs).toISOString() })), headlinesSeen: market.length }
  };
}

async function checkNews({ symbols, names, nowMs, cfg, key, fetchImpl, wait, withMarket = true }) {
  if (!key) throw new Error('No Gemini API key is set');
  const windowHours = cfg.newsWindowHours;
  const headlines = await allHeadlines({ symbols, names: names || {}, windowHours, nowMs, fetchImpl });
  if (symbols.every(s => !headlines[s].ok)) throw new Error('News feed unavailable for every stock: ' + headlines[symbols[0]].error);
  let market = [];
  if (withMarket) { try { market = await marketHeadlines({ windowHours, nowMs, fetchImpl }); } catch (e) { market = []; } }
  const prompt = buildPrompt({ symbols, names: names || {}, headlines, market, windowHours, nowMs });
  const { model, text } = await callGemini({ prompt, key, models: modelList(cfg), fetchImpl, wait });
  const result = validate(extractJson(text), { symbols, headlines, market });
  if (!withMarket) result.market = { risk: 'unknown', summary: '', sources: [], headlinesSeen: 0 };
  return { model, ...result, fetchedAt: Date.now(), windowHours };
}

module.exports = { checkNews, buildPrompt, validate, extractJson, callGemini };
