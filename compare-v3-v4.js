// Compare strategy versions on the same sessions, using Yahoo 5-minute candles (about 59 sessions
// of history; 1-minute data only goes back 7 days).
//   node compare-v3-v4.js                 (last 30 sessions)
//   node compare-v3-v4.js --days 20
//   node compare-v3-v4.js --tv data/tv-5m --days 60   (5-minute CSV files exported from TradingView: NIFTY_5.csv, <SYMBOL>_5.csv)
// APPROXIMATIONS, same for every version so the comparison stays fair:
//  - stops, targets and breakeven are checked on 5-minute bars (engine uses 1-minute); stop is checked before target
//  - no news check, no backup stocks for dead slots, each day starts with the full capital
//  - volume baseline = up to 20 earlier sessions in the same download (at least 10 needed)
// V3 = the frozen live rules. V4 = V3 + same-slot RVOL >= 1.0, cumulative RVOL >= 1.0, sector index
// confirmation, breakeven at +1R. Gap size is only logged (see the gap table), not filtered.
const fs = require('fs');
const path = require('path');
const base = require('./config');
const { yf } = require('./lib/data');
const { analyzeDaily, pickStocks, makeLeg, r05 } = require('./lib/planner');
const { vwap, avg } = require('./lib/indicators');
const { dayKey, minOfDay, OPEN } = require('./lib/time');
const { charges } = require('./lib/engine');
const { SECTOR_OF, SECTOR_INDEXES } = require('./sectors');

const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : null; };
const DAYS = +arg('days') || 30;
const SQ = base.squareOffMin;
const CACHE = path.join(__dirname, 'data', 'hist-cache');

// ---------------- data (cached on disk for the day) ----------------
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function cached(sym, interval, range) {
  fs.mkdirSync(CACHE, { recursive: true });
  const f = path.join(CACHE, `${sym.replace(/[^A-Za-z0-9]/g, '_')}-${interval}-${range}-${dayKey(Date.now())}.json`);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const d = await yf(sym, interval, range);
  fs.writeFileSync(f, JSON.stringify(d));
  return d;
}
async function loadAll(symbols, interval, range) {
  const out = {}; let i = 0, failed = 0;
  const worker = async () => {
    while (i < symbols.length) {
      const s = symbols[i++];
      try { out[s] = await cached(s, interval, range); } catch (e) { failed++; }
      await sleep(120);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (failed) console.log(`  (${failed} ${interval} downloads failed and are skipped)`);
  return out;
}
const byDay = bars => { const m = {}; for (const b of bars) (m[dayKey(b.t)] = m[dayKey(b.t)] || []).push(b); return m; };

// ---------------- variants ----------------
const V3 = { name: 'V3 (frozen live rules)', beR: 0.5 };
const V4 = { name: 'V4 (RVOL + cum RVOL + sector + BE 1R)', beR: 1, histRvol: 1.0, cumRvol: 1.0, sector: true };
const VARIANTS = [
  V3, V4,
  { name: '  V3 + same-slot RVOL >= 1.0', beR: 0.5, histRvol: 1.0 },
  { name: '  V3 + same-slot RVOL >= 1.2', beR: 0.5, histRvol: 1.2 },
  { name: '  V3 + same-slot RVOL >= 1.5', beR: 0.5, histRvol: 1.5 },
  { name: '  V3 + cumulative RVOL >= 1.0', beR: 0.5, cumRvol: 1.0 },
  { name: '  V3 + sector confirmation', beR: 0.5, sector: true },
  { name: '  V3 + breakeven at +1R', beR: 1 },
  { name: '  V3 + fixed 2R, no breakeven/trail', beR: 99 },
  { name: '  V3 + reject unclamped bad stops', beR: 0.5, structural: true },
  { name: '  V3 + max 2 per sector', beR: 0.5, sectorCap: 2 }
];

// ---------------- one session ----------------
function simDay(day, V, ctx) {
  const { picked, bars, idxBars, secBars, vixPrev, baseline } = ctx;
  const cfg = { ...base, riskPct: base.riskPct * (vixPrev >= base.vixHigh ? 0.5 : vixPrev >= base.vixElevated ? 0.75 : 1) };
  const slip = cfg.slippagePct / 100;
  let realized = 0, positions = [], tradesToday = 0, halted = false;
  const trades = [];
  const eq = () => cfg.capital + realized;

  // plans from the opening range (first 15 minutes = first 3 bars)
  const plans = [];
  for (const info of picked) {
    const b5 = bars[info.sym];
    const orc = b5.filter(b => minOfDay(b.t) < OPEN + cfg.orMinutes);
    if (orc.length < 3) continue;
    const hi = Math.max(...orc.map(c => c.h)), lo = Math.min(...orc.map(c => c.l));
    const mid = (hi + lo) / 2, rangePct = ((hi - lo) / mid) * 100;
    if (rangePct < cfg.minOrPct || rangePct > cfg.maxOrPct) continue;
    const gapPct = (orc[0].o / info.close - 1) * 100;
    const buf = cfg.triggerBufferPct / 100;
    const plan = { sym: info.sym, info, gapPct, legs: {}, status: 'waiting', sector: SECTOR_OF[info.sym] || null };
    const bad = trig => { const d = Math.abs(trig - mid) / trig * 100; return d < cfg.minStopPct || d > cfg.maxStopPct; };
    if (info.bias !== 'bear') { const t = hi * (1 + buf); if (!(V.structural && bad(t))) plan.legs.long = makeLeg('long', t, mid, cfg, eq()); }
    if (cfg.allowShort && info.bias !== 'bull') { const t = lo * (1 - buf); if (!(V.structural && bad(t))) plan.legs.short = makeLeg('short', t, mid, cfg, eq()); }
    if (Object.values(plan.legs).some(l => l.status === 'waiting')) plans.push(plan);
  }

  const marks = sym => { const b = bars[sym]; return b[b.length - 1]; };
  const close = (pos, price, reason, t) => {
    const dir = pos.side === 'long' ? 1 : -1;
    const gross = (price - pos.entry) * dir * pos.qty, fee = charges(dir === 1 ? 'SELL' : 'BUY', pos.qty * price);
    const net = gross - fee - pos.fee;
    realized += gross - fee;
    positions = positions.filter(p => p !== pos);
    trades.push({ day, sym: pos.sym, side: pos.side, net, r: net / (pos.R * pos.qty), reason, gapPct: pos.gapPct, sector: pos.sector, tIn: pos.t, tOut: t, entry: pos.entry, sl0: pos.sl0, tp: pos.tp, R: pos.R, feat: pos.feat });
  };
  const slipPx = (px, side, out) => px * (1 + (side === 'long' ? -1 : 1) * (out ? 1 : -1) * slip);

  const n = bars[picked[0].sym].length;
  const idxAt = (arr, endT) => { const a = arr.filter(k => k.t < endT); return a.length ? (a[a.length - 1].c > vwap(a) ? 'up' : 'down') : 'unknown'; };

  for (let i = 3; i < n; i++) {
    const t = (bars[picked[0].sym][i] || {}).t;
    if (t == null) break;
    const mod = minOfDay(t);

    // 1) exits on this bar (positions entered on an earlier bar)
    for (const pos of positions.slice()) {
      const k = bars[pos.sym].find(x => x.t === t);
      if (!k || k.t <= pos.t) continue;
      if (mod >= SQ) { close(pos, r05(slipPx(k.o, pos.side, true)), 'Square-off', t); continue; }
      const long = pos.side === 'long';
      let hit = null;
      if (long) {
        if (k.o <= pos.sl) hit = [k.o * (1 - slip), 'Stop (gap)']; else if (k.l <= pos.sl) hit = [pos.sl * (1 - slip), 'Stop'];
        else if (k.o >= pos.tp) hit = [k.o, 'Target']; else if (k.h >= pos.tp) hit = [pos.tp, 'Target'];
      } else {
        if (k.o >= pos.sl) hit = [k.o * (1 + slip), 'Stop (gap)']; else if (k.h >= pos.sl) hit = [pos.sl * (1 + slip), 'Stop'];
        else if (k.o <= pos.tp) hit = [k.o, 'Target']; else if (k.l <= pos.tp) hit = [pos.tp, 'Target'];
      }
      if (hit) { close(pos, r05(hit[0]), hit[1], t); continue; }
      const dir = long ? 1 : -1;
      pos.best = dir === 1 ? Math.max(pos.best, k.h) : Math.min(pos.best, k.l);
      const g = ((pos.best - pos.entry) * dir) / pos.R;
      let ns = pos.sl;
      if (g >= V.beR) ns = dir === 1 ? Math.max(ns, pos.entry) : Math.min(ns, pos.entry);
      if (V.beR < 90 && g >= 1.5) ns = dir === 1 ? Math.max(ns, pos.best - pos.R) : Math.min(ns, pos.best + pos.R);
      ns = r05(ns);
      if (dir === 1 ? ns > pos.sl : ns < pos.sl) pos.sl = ns;
    }
    if (mod >= SQ) break;

    // 2) entries on this bar's close
    if (!halted && mod + 5 <= cfg.lastEntryMin) {
      const endT = t + 300000;
      const idxState = idxAt(idxBars, endT);
      for (const plan of plans) {
        if (plan.status !== 'waiting') continue;
        const b5 = bars[plan.sym], b = b5[i];
        if (!b) continue;
        if (positions.length >= cfg.maxPositions || tradesToday >= cfg.maxTradesPerDay) break;
        const done = b5.slice(0, i + 1), vw = vwap(done);
        const volRatio = b.v / (avg(done.map(x => x.v)) || 1);
        for (const side of ['long', 'short']) {
          const leg = plan.legs[side];
          if (!leg || leg.status !== 'waiting') continue;
          const dir = side === 'long' ? 1 : -1;
          if (dir === 1 ? b.l <= leg.sl && b.c < leg.trigger : b.h >= leg.sl && b.c > leg.trigger) { leg.status = 'expired'; continue; }
          if (dir === 1 ? b.h >= leg.tp : b.l <= leg.tp) { leg.status = 'expired'; continue; }
          if (!(dir === 1 ? b.c > leg.trigger : b.c < leg.trigger)) continue;
          if (!(dir === 1 ? b.c > vw : b.c < vw)) continue;
          if (volRatio < cfg.minVolRatio) continue;
          if (idxState !== 'unknown' && idxState !== (dir === 1 ? 'up' : 'down')) continue;
          if ((Math.abs(b.c - leg.trigger) / leg.trigger) * 100 > cfg.maxChasePct) continue;
          // ---- V4 additions ----
          const bl = baseline[plan.sym] && baseline[plan.sym][mod];
          const cumVol = done.reduce((a, x) => a + x.v, 0);
          const secSt = plan.sector ? idxAt(secBars[plan.sector] || [], endT) : 'none';
          const feat = { volRatio, rvolSlot: bl && bl.slot > 0 ? b.v / bl.slot : null, rvolCum: bl && bl.cum > 0 ? cumVol / bl.cum : null, sectorState: secSt, sectorAgrees: secSt === 'none' || secSt === 'unknown' ? null : secSt === (dir === 1 ? 'up' : 'down'), niftyState: idxState, gapPct: plan.gapPct, minute: mod };
          if (V.histRvol && !(bl && bl.slot > 0 && b.v / bl.slot >= V.histRvol)) continue;
          if (V.cumRvol) {
            const cum = done.reduce((a, x) => a + x.v, 0);
            if (!(bl && bl.cum > 0 && cum / bl.cum >= V.cumRvol)) continue;
          }
          if (V.sector && plan.sector) {
            const s = idxAt(secBars[plan.sector] || [], endT);
            if (s !== 'unknown' && s !== (dir === 1 ? 'up' : 'down')) continue;
          }
          if (V.sectorCap && plan.sector && positions.filter(p => p.sector === plan.sector).length >= V.sectorCap) continue;

          const fill = r05(b.c * (1 + dir * slip)), dist = Math.abs(fill - leg.sl);
          if (dist < fill * 0.002) { leg.status = 'skipped'; continue; }
          const equity = eq() + positions.reduce((a, p) => a + (marks(p.sym).c - p.entry) * (p.side === 'long' ? 1 : -1) * p.qty, 0);
          const used = positions.reduce((a, p) => a + p.qty * p.entry, 0);
          const free = equity * cfg.leverage - used;
          const qty = Math.floor(Math.min((equity * cfg.riskPct) / 100 / dist, (equity * cfg.leverage * cfg.maxAllocPct) / 100 / fill, free / fill));
          if (qty < 1 || qty * dist < ((equity * cfg.riskPct) / 100) * 0.25) { leg.status = 'skipped'; continue; }
          const fee = charges(dir === 1 ? 'BUY' : 'SELL', qty * fill);
          realized -= fee;
          positions.push({ sym: plan.sym, side, qty, entry: fill, sl: leg.sl, sl0: leg.sl, feat, tp: r05(fill + dir * cfg.rr * dist), R: dist, t: endT - 300000 + 1, best: fill, fee, gapPct: plan.gapPct, sector: plan.sector });
          tradesToday++; plan.status = 'entered'; leg.status = 'entered';
          if (plan.legs.long && plan.legs.long !== leg) plan.legs.long.status = 'cancelled';
          if (plan.legs.short && plan.legs.short !== leg) plan.legs.short.status = 'cancelled';
          break;
        }
        if (positions.length >= cfg.maxPositions) break;
      }
    }

    // 3) daily loss limit
    const unreal = positions.reduce((a, p) => a + (marks(p.sym).c - p.entry) * (p.side === 'long' ? 1 : -1) * p.qty, 0);
    if (!halted && realized + unreal <= -(cfg.capital * cfg.dailyLossPct) / 100) {
      for (const p of positions.slice()) close(p, r05(slipPx(bars[p.sym].find(x => x.t === t).c, p.side, true)), 'Daily loss limit', t + 300000);
      halted = true;
    }
  }
  for (const p of positions.slice()) { const m = marks(p.sym); close(p, m.c, 'Data end', m.t); }
  return trades;
}

// ---------------- V3 trades with every V4 feature attached ----------------
// Exit what-ifs replay the same entry on 5-minute bars (gross R, no charges). "ambiguous" = a bar touched both stop and target.
function replay(t, m5, beR) {
  const d = t.side === 'long' ? 1 : -1, slip = base.slippagePct / 100;
  let sl = t.sl0, best = t.entry, ambiguous = false;
  for (const k of m5) {
    if (k.t <= t.tIn) continue;
    if (minOfDay(k.t) >= SQ) return { r: ((k.o * (1 - d * slip) - t.entry) * d) / t.R, ambiguous };
    const hitSl = d === 1 ? k.l <= sl : k.h >= sl, hitTp = d === 1 ? k.h >= t.tp : k.l <= t.tp;
    if (hitSl && hitTp) ambiguous = true;
    if (hitSl) return { r: (((d === 1 ? Math.min(k.o, sl) : Math.max(k.o, sl)) * (1 - d * slip) - t.entry) * d) / t.R, ambiguous };
    if (hitTp) return { r: ((t.tp - t.entry) * d) / t.R, ambiguous };
    best = d === 1 ? Math.max(best, k.h) : Math.min(best, k.l);
    const g = ((best - t.entry) * d) / t.R;
    let ns = sl;
    if (g >= beR) ns = d === 1 ? Math.max(ns, t.entry) : Math.min(ns, t.entry);
    if (beR < 90 && g >= 1.5) ns = d === 1 ? Math.max(ns, best - t.R) : Math.min(ns, best + t.R);
    ns = r05(ns);
    if (d === 1 ? ns > sl : ns < sl) sl = ns;
  }
  const k = m5[m5.length - 1];
  return { r: ((k.c - t.entry) * d) / t.R, ambiguous };
}

function featureReport(trades, intraByDay) {
  const rows = trades.map(t => {
    const m5 = intraByDay[t.sym][t.day], d = t.side === 'long' ? 1 : -1;
    const after = m5.filter(k => k.t > t.tIn && k.t < t.tOut + 1);
    const mfe = Math.max(0, ...after.map(k => (d === 1 ? k.h - t.entry : t.entry - k.l) / t.R));
    const mae = Math.max(0, ...after.map(k => (d === 1 ? t.entry - k.l : k.h - t.entry) / t.R));
    const a = replay(t, m5, 0.5), b = replay(t, m5, 1), c = replay(t, m5, 99);
    return { ...t, mfeR: mfe, maeR: mae, beHalfR: a.r, be1R: b.r, fixed2R: c.r, ambiguous: a.ambiguous || b.ambiguous || c.ambiguous };
  });
  const csv = ['day,sym,side,minute,gapPct,volRatio,rvolSlot,rvolCum,sectorState,sectorAgrees,niftyState,mfeR,maeR,actualR,beHalfR_replay,be1R_replay,fixed2R_replay,ambiguous,exit'];
  for (const r of rows) csv.push([r.day, r.sym, r.side, r.feat.minute, f(r.gapPct, 2), f(r.feat.volRatio, 2), f(r.feat.rvolSlot, 2), f(r.feat.rvolCum, 2), r.feat.sectorState, r.feat.sectorAgrees, r.feat.niftyState, f(r.mfeR), f(r.maeR), f(r.r), f(r.beHalfR), f(r.be1R), f(r.fixed2R), r.ambiguous, r.reason].join(','));
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'data', 'v3-features.csv'), csv.join('\n'));
  const sum = k => rows.reduce((x, r) => x + r[k], 0);
  console.log(`
V3 trades with exit what-ifs on the same entries (gross R, 5-minute replay, ${rows.length} trades):`);
  console.log(`  actual (net, live rules) ${f(sum('r'), 1)}R   BE +0.5R replay ${f(sum('beHalfR'), 1)}R   BE +1R replay ${f(sum('be1R'), 1)}R   fixed 2R replay ${f(sum('fixed2R'), 1)}R`);
  console.log(`  trades where a 5-minute bar touched both stop and target (true order unknown): ${rows.filter(r => r.ambiguous).length} of ${rows.length}`);
  const bucket = (title, key, edges) => {
    console.log(`
  By ${title}:`);
    for (let i = 0; i < edges.length - 1; i++) {
      const g = rows.filter(r => { const v = key(r); return v != null && v >= edges[i] && v < edges[i + 1]; });
      console.log('    ' + (`${edges[i]} to ${edges[i + 1] >= 99 ? 'more' : edges[i + 1]}`).padEnd(14) + (g.length ? `n=${String(g.length).padStart(3)}  win ${f(g.filter(r => r.r > 0).length / g.length * 100, 0).padStart(3)}%  avg ${f(g.reduce((x, r) => x + r.r, 0) / g.length).padStart(5)}R` : 'none'));
    }
    const na = rows.filter(r => key(r) == null).length; if (na) console.log('    no data       n=' + na);
  };
  bucket('cumulative RVOL (volume since 9:15 vs same period on past days)', r => r.feat.rvolCum, [0, 0.7, 1.0, 1.3, 99]);
  bucket('same-slot RVOL (breakout candle vs same candle on past days)', r => r.feat.rvolSlot, [0, 0.7, 1.0, 1.5, 99]);
  bucket('opening gap, absolute %', r => Math.abs(r.gapPct), [0, 0.5, 1, 2, 3, 99]);
  const sec = v => rows.filter(r => r.feat.sectorAgrees === v);
  console.log(`
  By sector index: agrees n=${sec(true).length} avg ${f(sec(true).reduce((x, r) => x + r.r, 0) / (sec(true).length || 1))}R | against n=${sec(false).length} avg ${f(sec(false).reduce((x, r) => x + r.r, 0) / (sec(false).length || 1))}R | no sector n=${sec(null).length}`);
  console.log('  Every trade with its features saved to data/v3-features.csv');
}

// ---------------- statistics ----------------
function stats(trades) {
  const n = trades.length;
  if (!n) return null;
  const wins = trades.filter(t => t.net > 0), gw = wins.reduce((a, t) => a + t.net, 0), gl = -trades.filter(t => t.net <= 0).reduce((a, t) => a + t.net, 0);
  let cum = 0, peak = 0, dd = 0, st = 0, ms = 0;
  for (const t of trades) { cum += t.net; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); st = t.net > 0 ? 0 : st + 1; ms = Math.max(ms, st); }
  return { n, win: wins.length / n * 100, avgR: trades.reduce((a, t) => a + t.r, 0) / n, totR: trades.reduce((a, t) => a + t.r, 0), pf: gl > 0 ? gw / gl : Infinity, net: cum, dd, ms, t2r: trades.filter(t => t.reason === 'Target').length / n * 100, sessions: new Set(trades.map(t => t.day)).size };
}
const f = (v, d = 2) => (v == null || !isFinite(v) ? '-' : v.toFixed(d));

(async () => {
  console.log('Downloading 5-minute and daily candles from Yahoo (cached for today in data/hist-cache) ...');
  const syms = base.watchlist, extra = [base.indexSymbol, ...SECTOR_INDEXES];
  const tv = arg('tv'), fyers = arg('fyers');
  let intra;
  if (tv) {
    // TradingView export: time_utc,open,high,low,close,volume. Sessions can end at 15:10 (72 bars) instead of 15:25.
    intra = {};
    const readCsv = f => fs.readFileSync(f, 'utf8').trim().split('\n').slice(1).map(l => l.split(',')).map(r => ({ t: Date.parse(r[0]), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
    const nf = path.join(tv, 'NIFTY_5.csv');
    if (!fs.existsSync(nf)) throw new Error('Missing ' + nf);
    intra[base.indexSymbol] = readCsv(nf);
    let have = 0;
    for (const s of syms) { const f = path.join(tv, s.replace(/[^A-Za-z0-9_&-]/g, '_') + '_5.csv'); if (fs.existsSync(f)) { intra[s] = readCsv(f); have++; } }
    console.log(`TradingView files: ${have} of ${syms.length} stocks loaded from ${tv}`);
  } else if (fyers) {
    // Fyers export (fyers-download.js): 1-minute CSVs, NIFTY.csv and <SYMBOL>.csv. Combined into 5-minute candles here.
    intra = {};
    const { aggregate } = require('./lib/indicators');
    const readCsv = f => aggregate(fs.readFileSync(f, 'utf8').trim().split('\n').slice(1).map(l => l.split(',')).map(r => ({ t: Date.parse(r[0]), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] })), 5);
    const nf = path.join(fyers, 'NIFTY.csv');
    if (!fs.existsSync(nf)) throw new Error('Missing ' + nf);
    intra[base.indexSymbol] = readCsv(nf);
    let have = 0;
    for (const s of syms) { const f = path.join(fyers, s.replace(/[^A-Za-z0-9_&-]/g, '_') + '.csv'); if (fs.existsSync(f)) { intra[s] = readCsv(f); have++; } }
    console.log(`Fyers files: ${have} of ${syms.length} stocks loaded from ${fyers}`);
  } else intra = await loadAll([...syms, ...extra], '5m', '60d');
  const daily = await loadAll([...syms, base.indexSymbol, base.vixSymbol], '1d', '2y');
  const idx = intra[base.indexSymbol];
  if (!idx) throw new Error('No Nifty 5-minute data');
  const idxDays = byDay(idx);
  const days = Object.keys(idxDays).sort().filter(d => idxDays[d].length >= 72);
  const test = days.slice(-DAYS);
  console.log(`Sessions with complete data: ${days.length}. Testing the last ${test.length}: ${test[0]} to ${test[test.length - 1]}\n`);

  const intraByDay = {};
  for (const s of Object.keys(intra)) intraByDay[s] = byDay(intra[s]);
  const results = VARIANTS.map(() => []);
  for (const day of test) {
    const infos = [];
    for (const s of syms) {
      if (!daily[s] || !intraByDay[s]) continue;
      const d = daily[s].filter(c => dayKey(c.t) < day);
      const info = analyzeDaily(s, d);
      if (info && (intraByDay[s][day] || []).length >= 72) infos.push(info);
    }
    const { picked } = pickStocks(infos, base, base.capital);
    if (!picked.length) continue;
    const bars = {}, baseline = {};
    const prior = days.filter(d => d < day).slice(-20);
    for (const info of picked) {
      bars[info.sym] = intraByDay[info.sym][day];
      const hist = prior.map(d => intraByDay[info.sym][d]).filter(a => a && a.length >= 72);
      baseline[info.sym] = {};
      if (hist.length >= 10) {
        for (let k = 0; k < 75; k++) {
          const slotMin = OPEN + k * 5;
          baseline[info.sym][slotMin] = {
            slot: avg(hist.map(a => (a[k] ? a[k].v : 0))),
            cum: avg(hist.map(a => a.slice(0, k + 1).reduce((x, b) => x + b.v, 0)))
          };
        }
      }
    }
    // keep only bars aligned to the same 75 slots
    const secBars = {};
    for (const si of SECTOR_INDEXES) secBars[si] = (intraByDay[si] && intraByDay[si][day]) || [];
    const vd = (daily[base.vixSymbol] || []).filter(c => dayKey(c.t) < day);
    const vixPrev = vd.length ? vd[vd.length - 1].c : 0;
    const ctx = { picked, bars, idxBars: idxDays[day], secBars, vixPrev, baseline };
    VARIANTS.forEach((V, i) => results[i].push(...simDay(day, V, ctx)));
  }

  console.log('Variant'.padEnd(42) + ' trades  win%   avgR  totalR    PF     net   maxDD  lossStreak  2R%');
  VARIANTS.forEach((V, i) => {
    const s = stats(results[i]);
    if (!s) return console.log(V.name.padEnd(42) + ' no trades');
    console.log(V.name.padEnd(42) + String(s.n).padStart(7) + f(s.win, 0).padStart(6) + f(s.avgR).padStart(7) + f(s.totR, 1).padStart(8) + f(s.pf).padStart(7) + f(s.net, 0).padStart(8) + f(s.dd, 0).padStart(8) + String(s.ms).padStart(9) + f(s.t2r, 0).padStart(8));
  });

  // V3 vs V4: same trade or different?
  const key = t => t.day + t.sym + t.side;
  const a = new Set(results[0].map(key)), b = new Set(results[1].map(key));
  const only3 = results[0].filter(t => !b.has(key(t))), only4 = results[1].filter(t => !a.has(key(t)));
  console.log(`\nTrades in V3 but not V4: ${only3.length} (sum ${f(only3.reduce((x, t) => x + t.r, 0), 1)}R).  In V4 but not V3: ${only4.length} (sum ${f(only4.reduce((x, t) => x + t.r, 0), 1)}R).  Same trade both: ${results[0].filter(t => b.has(key(t))).length}`);

  // gap context for V3 trades
  const B = [['< 0.5%', 0, 0.5], ['0.5 - 1%', 0.5, 1], ['1 - 2%', 1, 2], ['2 - 3%', 2, 3], ['3% or more', 3, 99]];
  console.log('\nV3 trades by size of the opening gap (absolute):');
  for (const [name, lo, hi] of B) {
    const g = results[0].filter(t => Math.abs(t.gapPct) >= lo && Math.abs(t.gapPct) < hi), s = stats(g);
    console.log('  ' + name.padEnd(12) + (s ? `n=${String(s.n).padStart(3)}  win ${f(s.win, 0).padStart(3)}%  avg ${f(s.avgR).padStart(5)}R  total ${f(s.totR, 1).padStart(6)}R` : 'none'));
  }
  featureReport(results[0], intraByDay);
  const s3 = stats(results[0]);
  console.log(`\nSample: V3 had ${s3 ? s3.n : 0} trades over ${s3 ? s3.sessions : 0} sessions. Under about 100 trades the differences above are mostly noise.`);
  console.log('Each variant was picked by looking at the same sessions it is scored on. Do not treat the best row as proven.');
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });
