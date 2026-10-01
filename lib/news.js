// Manual pre-market news screen: no API key, no automated calls. Each morning you copy a
// prompt into any chat AI (ChatGPT, etc.), paste its reply back, and the bot applies it.
function buildPrompt(symbols, nowMs) {
  const date = new Date(nowMs || Date.now()).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full' });
  return `You are a pre-market risk screener for an Indian same-day (intraday) equity trader. Today is ${date} (IST). Use web search if you have it, and only rely on news from the last 36 hours.

For EACH stock below (NSE symbols), decide if it is safe to trade normally today. Mark it false if you find: results due today or yesterday, regulatory or legal action, fraud allegations, management exits, large block or bulk deals, a rating downgrade, an F&O ban or trading restriction, or if there is major market-wide event risk today (RBI policy, US Fed/CPI, Union Budget, election results, big F&O expiry, a large global sell-off, geopolitical shock). Otherwise mark it true. Be conservative but do not invent news you are not reasonably sure of.

Stocks: ${symbols.join(', ')}

Reply with ONLY a JSON object, one boolean per symbol, and nothing else:
{"${symbols[0] || 'SYMBOL'}": true}`;
}

function parseVerdicts(text, symbols) {
  if (!text || !text.trim()) throw new Error('Paste the reply text first');
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : text;
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('Could not find a {...} JSON object in the pasted text');
  let obj;
  try { obj = JSON.parse(raw.slice(a, b + 1)); } catch (e) { throw new Error('That JSON did not parse: ' + e.message); }
  const verdicts = {};
  for (const sym of symbols) {
    const v = obj[sym];
    verdicts[sym] = typeof v === 'boolean' ? v : true; // unlisted or malformed = allow
  }
  return verdicts;
}

module.exports = { buildPrompt, parseVerdicts };
