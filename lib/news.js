// Manual pre-market news screen: no API key, no automated calls. Each morning you copy a
// prompt into any chat AI (ChatGPT, etc.), paste its reply back, and the bot applies it.
// The reply has two separate parts: a market-wide risk level (cuts position size, never blocks
// every stock) and a true/false per stock using only that stock's own news.
function buildPrompt(symbols, nowMs, withMarket, names) {
  const date = new Date(nowMs || Date.now()).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full' });
  const first = symbols[0] || 'SYMBOL';
  const market = withMarket ? `
Separately, rate the market-wide event risk for today as one word:
- "normal": nothing unusual.
- "elevated": one notable event (monthly F&O expiry, important US data, a moderate global sell-off).
- "high": a major scheduled or sudden event (RBI policy decision, US Fed decision, Union Budget, election results, a large global crash, a geopolitical shock).
Market-wide risk must NOT make you mark individual stocks false. It is only reported through the "market" field.
` : '';
  const reply = withMarket
    ? `{"market": "normal", "stocks": {"${first}": true}}`
    : `{"${first}": true}`;
  return `You are a pre-market risk screener for an Indian same-day (intraday) equity trader. Today is ${date} (IST). Use web search if you have it, and only rely on news from the last 36 hours.

For EACH stock below (NSE symbols), decide if it is safe to trade normally today, using only news about that stock or its own sector. Mark it false if you find: results due today or yesterday, regulatory or legal action, fraud allegations, management exits, large block or bulk deals, a rating downgrade, or an F&O ban or trading restriction. Otherwise mark it true. Be conservative but do not invent news you are not reasonably sure of.
${market}
Stocks (NSE symbol and company name): ${symbols.map(s => (names && names[s] ? `${s} (${names[s]})` : s)).join(', ')}

Reply with ONLY a JSON object, nothing else:
${reply}`;
}

// Accepts {"market": "...", "stocks": {...}} or the older flat {"SYM": true}.
function parseNews(text, symbols) {
  if (!text || !text.trim()) throw new Error('Paste the reply text first');
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : text;
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('Could not find a {...} JSON object in the pasted text');
  let obj;
  try { obj = JSON.parse(raw.slice(a, b + 1)); } catch (e) { throw new Error('That JSON did not parse: ' + e.message); }
  const stocks = obj.stocks && typeof obj.stocks === 'object' ? obj.stocks : obj;
  const verdicts = {};
  for (const sym of symbols) {
    const v = stocks[sym];
    verdicts[sym] = typeof v === 'boolean' ? v : null; // unlisted or malformed = unverified, never assumed safe
  }
  const m = typeof obj.market === 'string' ? obj.market.trim().toLowerCase() : null;
  return { verdicts, market: ['normal', 'elevated', 'high'].includes(m) ? m : null };
}

const parseVerdicts = (text, symbols) => parseNews(text, symbols).verdicts;

module.exports = { buildPrompt, parseNews, parseVerdicts };
