const { ema, rsi, atr, avg } = require('./indicators');
const { minOfDay, OPEN } = require('./time');

const r05 = x => Math.round(x * 20) / 20;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Step 1: read the daily chart of one stock and describe it.
function analyzeDaily(sym, daily) {
  if (daily.length < 55) return null;
  const closes = daily.map(c => c.c);
  const last = daily[daily.length - 1];
  const e20 = ema(closes, 20), e50 = ema(closes, 50), r = rsi(closes, 14), a = atr(daily, 14);
  const avgVol = avg(daily.slice(-20).map(c => c.v));
  const mom5 = (last.c / closes[closes.length - 6] - 1) * 100;
  const pp = (last.h + last.l + last.c) / 3, span = last.h - last.l;
  let bias = 'neutral';
  if (last.c > e20 && e20 > e50 && r > 50) bias = 'bull';
  else if (last.c < e20 && e20 < e50 && r < 50) bias = 'bear';
  const atrPct = (a / last.c) * 100;
  const trendPct = (Math.abs(e20 - e50) / last.c) * 100;
  const aligned = bias === 'bull' ? mom5 : bias === 'bear' ? -mom5 : 0;
  const score = trendPct * 2 + Math.max(aligned, 0) + Math.min(atrPct, 3) * 0.5 + (bias !== 'neutral' ? 2 : 0);
  let why;
  if (bias === 'bull') why = `Uptrend: price above the 20-day and 50-day averages, RSI ${r.toFixed(0)}, ${mom5 >= 0 ? 'up' : 'down'} ${Math.abs(mom5).toFixed(1)}% in 5 days.`;
  else if (bias === 'bear') why = `Downtrend: price below the 20-day and 50-day averages, RSI ${r.toFixed(0)}, ${mom5 >= 0 ? 'up' : 'down'} ${Math.abs(mom5).toFixed(1)}% in 5 days.`;
  else why = `No clear trend (RSI ${r.toFixed(0)}). Only trades if it breaks out with the market.`;
  return {
    sym, close: last.c, prevHigh: last.h, prevLow: last.l,
    pivot: { pp, r1: 2 * pp - last.l, s1: 2 * pp - last.h, r2: pp + span, s2: pp - span },
    ema20: e20, ema50: e50, rsi: r, atr: a, atrPct, turnover: avgVol * last.c, mom5, bias, score, why
  };
}

// Step 2: choose which stocks deserve attention today.
function pickStocks(infos, cfg, equity) {
  const maxPrice = equity * cfg.leverage * (cfg.maxAllocPct / 100);
  const ok = [], rejected = [];
  for (const i of infos) {
    if (i.atrPct < cfg.minAtrPct) rejected.push({ sym: i.sym, why: `Moves too little (ATR ${i.atrPct.toFixed(1)}%)` });
    else if (i.atrPct > cfg.maxAtrPct) rejected.push({ sym: i.sym, why: `Too volatile (ATR ${i.atrPct.toFixed(1)}%)` });
    else if (i.turnover < cfg.minTurnover) rejected.push({ sym: i.sym, why: 'Not liquid enough' });
    else if (i.close > maxPrice) rejected.push({ sym: i.sym, why: `Price ${i.close.toFixed(0)} is above what ${equity.toFixed(0)} capital can hold in one stock` });
    else ok.push(i);
  }
  ok.sort((a, b) => b.score - a.score);
  const picked = ok.slice(0, cfg.shortlistSize);
  for (const i of ok.slice(cfg.shortlistSize)) rejected.push({ sym: i.sym, why: 'Ranked below the shortlist' });
  return { picked, rejected };
}

function makeLeg(side, trigger, mid, cfg, equity) {
  const dir = side === 'long' ? 1 : -1;
  const dist = clamp(Math.abs(trigger - mid), (trigger * cfg.minStopPct) / 100, (trigger * cfg.maxStopPct) / 100);
  const sl = r05(trigger - dir * dist), tp = r05(trigger + dir * cfg.rr * dist);
  const d = Math.abs(trigger - sl);
  const qty = Math.floor(Math.min((equity * cfg.riskPct) / 100 / d, (equity * cfg.leverage * cfg.maxAllocPct) / 100 / trigger));
  return {
    side, trigger: r05(trigger), sl, tp, qty, risk: Math.max(0, qty) * d,
    status: qty >= 1 ? 'waiting' : 'skipped', note: qty >= 1 ? '' : 'Quantity below 1 for this capital'
  };
}

// Step 3: after the opening range (first 15 minutes) is formed, write exact entry, stop and target levels.
function buildTradePlan(info, c1, cfg, equity) {
  const orc = c1.filter(c => minOfDay(c.t) < OPEN + cfg.orMinutes);
  if (orc.length < cfg.orMinutes - 3) return null;
  const hi = Math.max(...orc.map(c => c.h)), lo = Math.min(...orc.map(c => c.l));
  const mid = (hi + lo) / 2, rangePct = ((hi - lo) / mid) * 100;
  const gapPct = (orc[0].o / info.close - 1) * 100;
  const plan = { sym: info.sym, bias: info.bias, news: info.news || null, or: { hi, lo, rangePct }, gapPct, status: 'waiting', note: '', legs: {}, lastConsidered: 0 };
  if (rangePct < cfg.minOrPct) { plan.status = 'skipped'; plan.note = `Opening range too tight (${rangePct.toFixed(2)}%), breakouts are unreliable.`; return plan; }
  if (rangePct > cfg.maxOrPct) { plan.status = 'skipped'; plan.note = `Opening range too wide (${rangePct.toFixed(2)}%), stop would be too far.`; return plan; }
  const buf = cfg.triggerBufferPct / 100;
  const allow = info.allow || 'both';
  if (info.bias !== 'bear' && allow !== 'short') plan.legs.long = makeLeg('long', hi * (1 + buf), mid, cfg, equity);
  if (cfg.allowShort && info.bias !== 'bull' && allow !== 'long') plan.legs.short = makeLeg('short', lo * (1 - buf), mid, cfg, equity);
  if (!Object.keys(plan.legs).length) { plan.status = 'skipped'; plan.note = allow !== 'both' ? 'News limits this stock to one direction that its chart trend does not support.' : 'No allowed direction for this stock.'; }
  else if (Object.values(plan.legs).every(l => l.status === 'skipped')) { plan.status = 'skipped'; plan.note = 'Too expensive for the capital at the allowed risk.'; }
  return plan;
}

module.exports = { analyzeDaily, pickStocks, buildTradePlan, makeLeg, r05 };
