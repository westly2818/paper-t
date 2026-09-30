// Pre-market news screen using the Gemini API with Google Search grounding.
// It can only make the bot MORE careful (drop a stock, allow one direction, trade smaller). It never creates a trade.
const VERDICTS = ['allow', 'long_only', 'short_only', 'avoid'];

function models() {
  const list = [process.env.GEMINI_MODEL, 'gemini-3.5-flash', 'gemini-3.8-flash', 'gemini-2.5-flash'].filter(Boolean);
  return [...new Set(list)];
}

async function callGemini(prompt, key) {
  let lastErr = new Error('No Gemini model responded');
  for (const model of models()) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0.1 } }),
      signal: AbortSignal.timeout(90000)
    });
    if (res.status === 404) { lastErr = new Error(`model ${model} not available`); continue; }
    if (!res.ok) { const t = await res.text(); throw new Error(`Gemini HTTP ${res.status}: ${t.slice(0, 200)}`); }
    const j = await res.json();
    const cand = j.candidates && j.candidates[0];
    const text = cand && cand.content && cand.content.parts ? cand.content.parts.map(p => p.text || '').join('') : '';
    if (!text) throw new Error('Gemini returned an empty answer');
    const chunks = (cand.groundingMetadata && cand.groundingMetadata.groundingChunks) || [];
    const sources = chunks.map(c => c.web).filter(Boolean).slice(0, 8).map(w => ({ title: w.title || w.uri, uri: w.uri }));
    return { model, text, sources };
  }
  throw lastErr;
}

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : text;
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('Gemini answer was not JSON');
  return JSON.parse(raw.slice(a, b + 1));
}

async function runNewsGuard(symbols, cfg, nowMs) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set');
  const date = new Date(nowMs || Date.now()).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full' });
  const prompt = `You are a pre-market risk screener for an Indian same-day (intraday) equity trader. Today is ${date} (IST). Use Google Search and only rely on news from the last 36 hours.

1. MARKET: find scheduled or breaking events today that could move Indian markets sharply (RBI policy, US Fed or CPI, Union Budget, election results, monthly F&O expiry, a big global sell-off, geopolitical shocks). Set risk to "normal", "elevated" or "high".
2. For EACH stock below (NSE symbols) look for company-specific news: results due today or yesterday, regulatory or legal action, fraud allegations, management exits, large block or bulk deals, rating changes, big order wins, F&O ban or trading restrictions.

Stocks: ${symbols.join(', ')}

Verdict rules. Be conservative and choose "allow" when you find nothing concrete:
- "avoid": concrete event risk today (results due today, trading halt, major regulatory or legal shock, F&O ban)
- "long_only": clearly positive news and no adverse event
- "short_only": clearly negative news and no positive event
- "allow": nothing notable, or mixed

Reply with ONLY this JSON and nothing else:
{"market":{"risk":"normal","summary":"one sentence","events":["short event"]},"stocks":{"SYMBOL":{"verdict":"allow","sentiment":"neutral","reason":"max 20 words"}}}`;
  const { model, text, sources } = await callGemini(prompt, key);
  const j = extractJson(text);
  const mk = j.market || {};
  const market = {
    risk: ['normal', 'elevated', 'high'].includes(mk.risk) ? mk.risk : 'normal',
    summary: String(mk.summary || ''), events: Array.isArray(mk.events) ? mk.events.slice(0, 5).map(String) : []
  };
  const stocks = {};
  for (const sym of symbols) {
    const v = (j.stocks && j.stocks[sym]) || {};
    stocks[sym] = {
      verdict: VERDICTS.includes(v.verdict) ? v.verdict : 'allow',
      sentiment: ['positive', 'negative', 'neutral', 'mixed'].includes(v.sentiment) ? v.sentiment : 'neutral',
      reason: String(v.reason || 'No notable news found.').slice(0, 200)
    };
  }
  return { model, market, stocks, sources };
}

module.exports = { runNewsGuard, extractJson };
