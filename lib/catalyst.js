// For stocks that moved sharply at the open: is there a real, company-specific reason in the news published BEFORE the scan time?
// Same discipline as lib/gemini.js: we fetch the headlines ourselves (Google News RSS, exact publish times), Gemini only classifies them,
// every source shown is one of our headlines, and anything unverifiable is "unverified", never guessed.
// No headline published after the scan time is ever shown to the model (slackMs 0), so a move cannot be "explained" by news that came
// out because of the move.
const { allHeadlines } = require('./newsfeed');
const { callGemini, extractJson } = require('./gemini');

const CATEGORIES = ['results', 'upgrade_downgrade', 'order_or_contract', 'regulatory_or_legal', 'corporate_action', 'management', 'sector_or_market', 'other_company_news', 'none'];
const SCHEMA = {
  type: 'OBJECT',
  properties: {
    stocks: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
      symbol: { type: 'STRING' }, category: { type: 'STRING', enum: CATEGORIES }, sentiment: { type: 'STRING', enum: ['positive', 'negative', 'mixed', 'none'] },
      explains_move: { type: 'BOOLEAN' }, reason: { type: 'STRING' }, evidence: { type: 'ARRAY', items: { type: 'STRING' } }
    }, required: ['symbol', 'category', 'sentiment', 'explains_move', 'reason', 'evidence'] } }
  },
  required: ['stocks']
};
const FALLBACK_MODELS = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.8-flash'];
const fmt = ms => new Date(ms).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

function buildPrompt({ movers, names, headlines, nowMs, windowHours }) {
  const blocks = movers.map(m => {
    const h = headlines[m.sym] && headlines[m.sym].ok ? headlines[m.sym].kept : [];
    return `[${m.sym}] ${names[m.sym] || 'NSE-listed company with this exact symbol'} (NSE: ${m.sym}): ${m.movePct >= 0 ? '+' : ''}${m.movePct.toFixed(1)}% versus yesterday's close at 09:35 (opened ${m.gapPct >= 0 ? '+' : ''}${m.gapPct.toFixed(1)}%)\n` +
      (h.length ? h.map((x, k) => `  ${m.sym}#${k + 1} ${fmt(x.publishedMs)} | ${x.source || '?'} | ${x.title}`).join('\n') : '  (no headlines found)');
  }).join('\n\n');
  return `You are checking whether big opening moves on the Indian stock market have a real company-specific reason. Each stock below moved sharply by 09:35 IST. Below are headlines published in the last ${windowHours} hours, BEFORE ${fmt(nowMs)}. Use ONLY these headlines. Do not use memory or outside knowledge.

For EACH stock decide:
- category: the main kind of news: results, upgrade_downgrade (analyst rating or target change), order_or_contract, regulatory_or_legal, corporate_action (stake sale, fund raise, merger, bonus, split, dividend), management, sector_or_market (news about the sector or the whole market, not the company itself), other_company_news, or none (nothing relevant).
- sentiment: positive, negative, mixed or none, for the stock.
- explains_move: true ONLY if a headline reports a company-specific event whose direction fits the move (for example an upgrade or strong results for an up-move, a downgrade or a probe for a down-move). Market-wide commentary, "stocks to watch" lists, sector moves, and headlines that merely repeat the price move do NOT explain it.
- reason: at most 25 words naming what you saw. evidence: the headline ids (like ITC#2) that support your answer; at least one when explains_move is true.

STOCKS
${blocks}`;
}

const evidenceIds = (list, sym, count) => {
  const out = [];
  for (const e of Array.isArray(list) ? list : []) {
    const m = /^\s*([A-Za-z0-9&-]+)#(\d+)\s*$/.exec(String(e));
    if (m && m[1].toUpperCase() === sym.toUpperCase() && +m[2] >= 1 && +m[2] <= count && !out.includes(+m[2])) out.push(+m[2]);
  }
  return out;
};

// explainsMove: true / false / null (null = could not verify)
function validate(j, movers, headlines) {
  const by = {};
  for (const s of (j && Array.isArray(j.stocks) ? j.stocks : [])) if (s && typeof s.symbol === 'string') by[s.symbol.toUpperCase()] = s;
  const out = {};
  for (const m of movers) {
    const h = headlines[m.sym];
    const base = { category: null, sentiment: null, explainsMove: null, verified: false, reason: '', sources: [], headlinesSeen: h && h.ok ? h.kept.length : 0 };
    if (!h || !h.ok) { out[m.sym] = { ...base, reason: `News fetch failed (${h ? h.error : 'not fetched'}), so this is unverified.` }; continue; }
    if (!h.kept.length) { out[m.sym] = { ...base, category: 'none', sentiment: 'none', explainsMove: false, verified: true, reason: 'No relevant headlines were published before the scan.' }; continue; }
    const v = by[m.sym];
    if (!v || typeof v.explains_move !== 'boolean' || !CATEGORIES.includes(v.category)) { out[m.sym] = { ...base, reason: 'The model gave no valid answer for this stock.' }; continue; }
    const ids = evidenceIds(v.evidence, m.sym, h.kept.length);
    if (v.explains_move && !ids.length) { out[m.sym] = { ...base, reason: 'The model said the news explains the move but cited no headline, so it is unverified.' }; continue; }
    out[m.sym] = {
      category: v.category, sentiment: ['positive', 'negative', 'mixed', 'none'].includes(v.sentiment) ? v.sentiment : 'none', explainsMove: v.explains_move, verified: true,
      reason: String(v.reason || '').slice(0, 220), headlinesSeen: h.kept.length,
      sources: (ids.length ? ids : [1, 2]).filter(n => n <= h.kept.length).slice(0, 3).map(n => ({ title: h.kept[n - 1].title.slice(0, 140), url: h.kept[n - 1].url, source: h.kept[n - 1].source, published: new Date(h.kept[n - 1].publishedMs).toISOString() }))
    };
  }
  return out;
}

// movers: [{ sym, movePct, gapPct }], names: { sym: companyName }. Throws when Gemini itself fails (the caller keeps the movers, marked unchecked).
async function classifyMovers({ movers, names, nowMs, windowHours = 36, key, model, fetchImpl, wait }) {
  if (!key) throw new Error('No Gemini API key is set');
  const syms = movers.map(m => m.sym);
  const headlines = await allHeadlines({ symbols: syms, names, windowHours, nowMs, fetchImpl, slackMs: 0 });
  if (syms.every(s => !headlines[s].ok)) throw new Error('News feed unavailable for every stock: ' + headlines[syms[0]].error);
  const prompt = buildPrompt({ movers, names, headlines, nowMs, windowHours });
  const models = [...new Set([model, ...FALLBACK_MODELS].filter(Boolean))];
  const { model: used, text } = await callGemini({ prompt, key, models, fetchImpl, wait, schema: SCHEMA });
  return { model: used, byStock: validate(extractJson(text), movers, headlines) };
}

module.exports = { classifyMovers, buildPrompt, validate, CATEGORIES };
