// Does Gemini's morning "market risk" call (normal / elevated / high) predict how much Nifty actually moves that day?
// For each session: the real market headlines for that morning (date-limited Google News search, cached), the real prompt
// from lib/gemini.js with no stocks, one Gemini call (cached by prompt), then the call is compared with Nifty's real
// close-to-close move and high-low range that day. The bot cuts position size to 75% (elevated) or 50% (high) on this call,
// so the call is only useful if those days really are more volatile.
//   node --env-file=.env market-risk-test.js --from 2026-04-01
const fs = require('fs');
const path = require('path');
const base = require('./config');
const { marketHeadlines } = require('./lib/newsfeed');
const { buildPrompt, callGemini, extractJson, validate } = require('./lib/gemini');
const newsHistory = require('./news-history');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const from = arg('from', '2026-04-01'), to = arg('to', '2099-01-01');
if (!process.env.GEMINI_API_KEY) process.env.GEMINI_API_KEY = 'cached-only';
const key = process.env.GEMINI_API_KEY;
const MODELS = [...new Set([base.geminiModel, 'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.8-flash'])];

const nifty = fs.readFileSync(path.join(__dirname, 'data', 'fyers-daily', 'NIFTY.csv'), 'utf8').trim().split('\n').slice(1).map(l => l.split(',')).map(r => ({ day: r[0].slice(0, 10), o: +r[1], h: +r[2], l: +r[3], c: +r[4] }));
const vix = Object.fromEntries(fs.readFileSync(path.join(__dirname, 'data', 'fyers-daily', 'INDIAVIX.csv'), 'utf8').trim().split('\n').slice(1).map(l => l.split(',')).map(r => [r[0].slice(0, 10), +r[4]]));
const days = nifty.map(x => x.day).filter(d => d >= from && d <= to);
const OUT = path.join(__dirname, 'data', 'market-risk-calls.json');
const calls = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};

(async () => {
  let n = 0;
  for (const day of days) {
    if (calls[day]) continue;
    newsHistory.setDay(day);
    const nowMs = Date.parse(day + 'T03:46:00Z'); // 09:16 IST, when the live bot runs its news check
    try {
      const market = await marketHeadlines({ windowHours: base.newsWindowHours, nowMs, fetchImpl: newsHistory.historicalFetch });
      const prompt = buildPrompt({ symbols: [], names: {}, headlines: {}, market, windowHours: base.newsWindowHours, nowMs });
      const { model, text } = await callGemini({ prompt, key, models: MODELS, fetchImpl: newsHistory.historicalFetch, wait: () => Promise.resolve() });
      const res = validate(extractJson(text), { symbols: [], headlines: {}, market });
      calls[day] = { risk: res.market.risk, summary: res.market.summary, headlines: market.length, model };
    } catch (e) {
      console.log(`${day}: could not get a call (${e.message.slice(0, 90)}). Stopping; rerun later, answers so far are saved.`);
      break;
    }
    if (++n % 10 === 0) { fs.writeFileSync(OUT, JSON.stringify(calls)); console.log(`  ${day}: ${Object.keys(calls).length} sessions done`); }
  }
  fs.writeFileSync(OUT, JSON.stringify(calls));

  // ---------------- compare with what Nifty did ----------------
  const idx = new Map(nifty.map((x, i) => [x.day, i]));
  const rows = [];
  for (const day of days) {
    const c = calls[day], i = idx.get(day);
    if (!c || i < 1) continue;
    const prev = nifty[i - 1], x = nifty[i];
    rows.push({ day, risk: c.risk, absMove: Math.abs(x.c / prev.c - 1) * 100, range: (x.h - x.l) / prev.c * 100, ret: (x.c / prev.c - 1) * 100, vix: vix[prev.day] });
  }
  const mean = a => a.reduce((s, v) => s + v, 0) / (a.length || 1);
  const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length - 1)); };
  const ci = a => 1.96 * sd(a) / Math.sqrt(a.length);
  console.log(`\n${rows.length} sessions with a call (${rows[0] && rows[0].day} to ${rows[rows.length - 1] && rows[rows.length - 1].day}); models used: ${JSON.stringify(Object.values(calls).reduce((m, c) => (m[c.model] = (m[c.model] || 0) + 1, m), {}))}`);
  console.log('\nGemini call   sessions   Nifty |move|   Nifty high-low range   prior-day VIX');
  for (const k of ['normal', 'elevated', 'high', 'unknown']) {
    const g = rows.filter(r => r.risk === k);
    if (g.length) console.log(`  ${k.padEnd(10)} ${String(g.length).padStart(6)}      ${mean(g.map(r => r.absMove)).toFixed(2)}% (+/-${ci(g.map(r => r.absMove)).toFixed(2)})   ${mean(g.map(r => r.range)).toFixed(2)}% (+/-${ci(g.map(r => r.range)).toFixed(2)})      ${mean(g.filter(r => r.vix).map(r => r.vix)).toFixed(1)}`);
  }
  console.log(`  ${'all days'.padEnd(10)} ${String(rows.length).padStart(6)}      ${mean(rows.map(r => r.absMove)).toFixed(2)}%                  ${mean(rows.map(r => r.range)).toFixed(2)}%`);
  // does the call add anything beyond yesterday's VIX? split days by VIX
  const med = rows.map(r => r.vix).filter(Boolean).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
  const hiV = rows.filter(r => r.vix >= med), loV = rows.filter(r => r.vix < med);
  console.log(`\nBenchmark: days after a higher India VIX (>= ${med.toFixed(1)}): range ${mean(hiV.map(r => r.range)).toFixed(2)}% (+/-${ci(hiV.map(r => r.range)).toFixed(2)}) vs lower VIX: ${mean(loV.map(r => r.range)).toFixed(2)}% (+/-${ci(loV.map(r => r.range)).toFixed(2)})`);
  const calm = rows.filter(r => r.risk === 'normal'), alert = rows.filter(r => r.risk !== 'normal' && r.risk !== 'unknown');
  if (calm.length && alert.length) console.log(`"Not normal" days (elevated + high): range ${mean(alert.map(r => r.range)).toFixed(2)}% on ${alert.length} days vs normal days ${mean(calm.map(r => r.range)).toFixed(2)}% on ${calm.length} days; difference ${(mean(alert.map(r => r.range)) - mean(calm.map(r => r.range))).toFixed(2)} points (+/-${(1.96 * Math.sqrt(sd(alert.map(r => r.range)) ** 2 / alert.length + sd(calm.map(r => r.range)) ** 2 / calm.length)).toFixed(2)})`);
  console.log('\nRead it like this: if the ranges for elevated/high are clearly larger than for normal, the call identifies volatile days and the size cut is justified. If they overlap, the cut is noise.');
})().catch(e => { console.error('Failed:', e.stack || e.message); process.exit(1); });
