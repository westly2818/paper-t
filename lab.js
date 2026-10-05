// Strategy lab: five all-day candidate strategies on the whole Nifty 200, tested on Yahoo's free 5-minute history
// (about 59 sessions). Everything is fixed in advance. Do not tune the numbers after seeing a result.
//   node lab.js                     (downloads and caches data in data/lab-cache the first time)
//   node lab.js --only rs_pullback  (one strategy)
// Honest limits: 59 sessions is small, the universe is today's Nifty 200, 5-minute bars hide the order of
// stop and target inside a bar (the stop is assumed first, which is the conservative choice).
//
// Costs: the real MIS charges from lib/engine.js plus 0.02% slippage on market fills, risk Rs 200 per trade,
// at most Rs 10,000 per stock (the live bot's sizing at Rs 20,000 capital). Every R below is NET of costs.
// Universe each day: same filters as the live bot (ATR 1 to 4.5%, turnover over Rs 30 crore, price affordable).
//
// Candidates (decision is on a CLOSED 5-minute bar, entry at that bar's close):
//  rs_pullback   Stock far stronger (or weaker) than Nifty, price above (below) VWAP, orderly pullback of 20 to 60% of the
//                day's up-leg that holds VWAP on cooling volume, then a resumption bar. 10:30 to 15:00.
//  vwap_fade     Price 1.2% or more away from VWAP, then a reversal bar; target = VWAP. 10:30 to 14:30.
//  late_momentum After 13:30, close beyond the high (low) of the morning and midday, with relative strength and volume. 13:30 to 14:45.
//  midday_break  Tight 40-minute consolidation near the day's high (low), then a volume breakout. 10:30 to 13:30.
//  failed_orb    A breakout of the 9:15-9:30 range that closes back inside within two bars is faded. 9:40 to 10:30.
// Exit policies tested for each: P1 = stop and 2R target (VWAP target for vwap_fade), P2 = P1 plus stop to breakeven at +1R. Everything closed 15:15.
const fs = require('fs');
const path = require('path');
const base = require('./config');
const { yf } = require('./lib/data');
const { analyzeDaily } = require('./lib/planner');
const { charges } = require('./lib/engine');
const { dayKey, minOfDay } = require('./lib/time');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const ONLY = arg('only', null);
const CACHE = path.join(__dirname, 'data', 'lab-cache');
const RISK = 200, MAXVAL = 10000, SLIP = 0.0002, MAXPOS = 3, MAXTRADES = 6, RR = 2;
const OPEN = 555, SQ = 915; // minutes of day: 09:15, 15:15
const startMin = k => OPEN + 5 * k;

// ---------------- data ----------------
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function cached(name, fetcher) {
  fs.mkdirSync(CACHE, { recursive: true });
  const f = path.join(CACHE, name.replace(/[^A-Za-z0-9_.-]/g, '_') + '.json');
  if (fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < 12 * 3600e3) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const data = await fetcher();
  fs.writeFileSync(f, JSON.stringify(data));
  return data;
}
async function loadAll(syms) {
  const five = {}, daily = {};
  let i = 0, done = 0;
  const worker = async () => {
    while (i < syms.length) {
      const s = syms[i++];
      try {
        five[s] = await cached('5m-' + s, () => yf(s, '5m', '60d', 3));
        if (!s.startsWith('^')) daily[s] = await cached('1d-' + s, () => yf(s, '1d', '1y', 3));
      } catch (e) { /* symbol skipped */ }
      if (++done % 40 === 0) process.stdout.write(`  loaded ${done}/${syms.length}\r`);
      await sleep(60);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { five, daily };
}

// ---------------- one stock-day ----------------
function buildDay(bars, nifty) {
  const n = 75, o = new Array(n), h = new Array(n), l = new Array(n), c = new Array(n), v = new Array(n);
  for (const b of bars) { const k = (minOfDay(b.t) - OPEN) / 5; if (k >= 0 && k < n && Number.isInteger(k)) { o[k] = b.o; h[k] = b.h; l[k] = b.l; c[k] = b.c; v[k] = b.v; } }
  for (let k = 0; k < 72; k++) if (c[k] === undefined || nifty.c[k] === undefined) return null; // need a complete session up to 15:15
  const vw = [], pct = [], npct = [];
  let pv = 0, vv = 0, sum = 0, cnt = 0, nsum = 0;
  for (let k = 0; k < n; k++) {
    if (c[k] === undefined) { vw[k] = vw[k - 1]; pct[k] = pct[k - 1]; npct[k] = npct[k - 1]; continue; }
    const tp = (h[k] + l[k] + c[k]) / 3; pv += tp * v[k]; vv += v[k]; sum += tp; cnt++;
    vw[k] = vv > 0 ? pv / vv : sum / cnt;
    pct[k] = (c[k] / o[0] - 1) * 100;
    npct[k] = (nifty.c[k] / nifty.o[0] - 1) * 100;
  }
  return { o, h, l, c, v, vw, pct, npct, n, nUp: nifty.up };
}
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const maxOf = (a, i0, i1) => { let m = -Infinity; for (let i = i0; i <= i1; i++) if (a[i] > m) m = a[i]; return m; };
const minOfArr = (a, i0, i1) => { let m = Infinity; for (let i = i0; i <= i1; i++) if (a[i] < m) m = a[i]; return m; };
const argmax = (a, i0, i1) => { let m = -Infinity, ix = i0; for (let i = i0; i <= i1; i++) if (a[i] > m) { m = a[i]; ix = i; } return ix; };
const argmin = (a, i0, i1) => { let m = Infinity, ix = i0; for (let i = i0; i <= i1; i++) if (a[i] < m) { m = a[i]; ix = i; } return ix; };

// ---------------- the five candidates: each returns the FIRST signal of the day or null ----------------
// A signal: { k, side, stop, target?, rs }  (k = bar that just closed)
const STRATS = {
  // CALIBRATION 1: the live bot's opening-range breakout, run through this same executor on every eligible stock
  // (daily trend must allow the direction). Not a candidate; it shows whether this executor is fair.
  orb(d, info) {
    const orH = maxOf(d.h, 0, 2), orL = minOfArr(d.l, 0, 2), mid = (orH + orL) / 2, rng = (orH - orL) / mid * 100;
    if (rng < 0.3 || rng > 2.5) return null;
    for (let k = 3; k <= 17; k++) {
      const volOk = d.v[k] >= 0.9 * mean(d.v.slice(0, k + 1));
      const trL = orH * 1.0005, trS = orL * 0.9995;
      if (info.bias !== 'bear' && d.c[k] > trL && d.c[k] > d.vw[k] && volOk && d.nUp[k] && (d.c[k] - trL) / trL <= 0.004) {
        const dist = Math.min(Math.max(Math.abs(trL - mid), 0.004 * trL), 0.012 * trL);
        return { k, side: 'long', stop: trL - dist, rs: d.pct[k] - d.npct[k] };
      }
      if (info.bias !== 'bull' && d.c[k] < trS && d.c[k] < d.vw[k] && volOk && !d.nUp[k] && (trS - d.c[k]) / trS <= 0.004) {
        const dist = Math.min(Math.max(Math.abs(trS - mid), 0.004 * trS), 0.012 * trS);
        return { k, side: 'short', stop: trS + dist, rs: d.npct[k] - d.pct[k] };
      }
    }
    return null;
  },

  // CALIBRATION 2: a random entry (seeded by stock and day), random side, 0.8% stop. This is what "no edge" looks like in this executor.
  control_random(d) {
    let h = 7; for (const ch of d.key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const k = 14 + (h % 48), side = (h >> 7) & 1 ? 'long' : 'short';
    return { k, side, stop: d.c[k] * (side === 'long' ? 0.992 : 1.008), rs: 0 };
  },

  rs_pullback(d) {
    for (let k = 14; k <= 66; k++) {
      const rs = d.pct[k] - d.npct[k];
      for (const side of ['long', 'short']) {
        const s = side === 'long' ? 1 : -1;
        if (s * rs < 0.6) continue;
        if (!(s === 1 ? d.c[k] > d.vw[k] : d.c[k] < d.vw[k])) continue;
        const sw = s === 1 ? argmax(d.h, Math.max(0, k - 24), k - 2) : argmin(d.l, Math.max(0, k - 24), k - 2);
        const swPx = s === 1 ? d.h[sw] : d.l[sw];
        if (s === 1 ? swPx < maxOf(d.h, 0, k - 1) : swPx > minOfArr(d.l, 0, k - 1)) continue; // the swing must be the day's extreme so far
        const start = s === 1 ? minOfArr(d.l, 0, sw) : maxOf(d.h, 0, sw);
        const leg = s * (swPx - start);
        if (leg < 0.01 * swPx || k - 1 - sw < 2) continue;
        const pbLow = s === 1 ? minOfArr(d.l, sw + 1, k - 1) : maxOf(d.h, sw + 1, k - 1);
        const depth = s * (swPx - pbLow) / leg;
        if (depth < 0.2 || depth > 0.6) continue;
        let holds = true;
        for (let q = sw + 1; q <= k - 1; q++) if (s * ((s === 1 ? d.l[q] : d.h[q]) - d.vw[q]) / d.vw[q] < -0.002) holds = false;
        if (!holds) continue;
        const pbVol = mean(d.v.slice(sw + 1, k)), impVol = mean(d.v.slice(Math.max(0, sw - 5), sw + 1));
        if (!(pbVol <= 0.8 * impVol)) continue;
        const trig = s === 1 ? d.c[k] > d.h[k - 1] && d.c[k] > d.o[k] : d.c[k] < d.l[k - 1] && d.c[k] < d.o[k];
        if (!trig || d.v[k] < pbVol) continue;
        return { k, side, stop: pbLow * (1 - s * 0.001), rs: s * rs };
      }
    }
    return null;
  },

  vwap_fade(d) {
    for (let k = 14; k <= 62; k++) {
      const dev = (d.c[k] - d.vw[k]) / d.vw[k], devPrev = (d.c[k - 1] - d.vw[k - 1]) / d.vw[k - 1];
      if (dev >= 0.012 && devPrev >= 0.008 && d.c[k] < d.o[k] && d.c[k] < d.l[k - 1]) return { k, side: 'short', stop: Math.max(d.h[k], d.h[k - 1]) * 1.001, target: d.vw[k], rs: dev * 100, minReward: 1.2 };
      if (dev <= -0.012 && devPrev <= -0.008 && d.c[k] > d.o[k] && d.c[k] > d.h[k - 1]) return { k, side: 'long', stop: Math.min(d.l[k], d.l[k - 1]) * 0.999, target: d.vw[k], rs: -dev * 100, minReward: 1.2 };
    }
    return null;
  },

  late_momentum(d) {
    const pre = { hi: maxOf(d.h, 0, 50), lo: minOfArr(d.l, 0, 50) }; // morning and midday, up to the bar starting 13:25
    for (let k = 51; k <= 61; k++) {
      const rs = d.pct[k] - d.npct[k], volAvg = mean(d.v.slice(36, k));
      if (d.c[k] > pre.hi * 1.0005 && d.c[k] > d.vw[k] && rs >= 0.5 && d.v[k] >= 1.2 * volAvg) return { k, side: 'long', stop: minOfArr(d.l, k - 5, k) * 0.999, rs };
      if (d.c[k] < pre.lo * 0.9995 && d.c[k] < d.vw[k] && rs <= -0.5 && d.v[k] >= 1.2 * volAvg) return { k, side: 'short', stop: maxOf(d.h, k - 5, k) * 1.001, rs: -rs };
    }
    return null;
  },

  midday_break(d) {
    for (let k = 14; k <= 52; k++) {
      const hi = maxOf(d.h, k - 8, k - 1), lo = minOfArr(d.l, k - 8, k - 1);
      if ((hi - lo) / d.c[k] > 0.007) continue;
      const dayHi = maxOf(d.h, 0, k - 1), dayLo = minOfArr(d.l, 0, k - 1), rs = d.pct[k] - d.npct[k], volAvg = mean(d.v.slice(k - 8, k));
      const pos = (d.c[k - 1] - dayLo) / (dayHi - dayLo || 1);
      if (d.c[k] > hi && d.c[k] > d.vw[k] && pos >= 0.7 && rs >= 0.3 && d.v[k] >= 1.3 * volAvg) return { k, side: 'long', stop: lo * 0.999, rs };
      if (d.c[k] < lo && d.c[k] < d.vw[k] && pos <= 0.3 && rs <= -0.3 && d.v[k] >= 1.3 * volAvg) return { k, side: 'short', stop: hi * 1.001, rs: -rs };
    }
    return null;
  },

  failed_orb(d) {
    const orH = maxOf(d.h, 0, 2), orL = minOfArr(d.l, 0, 2), mid = (orH + orL) / 2;
    if ((orH - orL) / mid < 0.003 || (orH - orL) / mid > 0.025) return null;
    for (let k = 4; k <= 15; k++) {
      const brokeUp = [k - 1, k - 2].some(q => q >= 3 && d.c[q] > orH * 1.0005), brokeDn = [k - 1, k - 2].some(q => q >= 3 && d.c[q] < orL * 0.9995);
      if (brokeUp && d.c[k] < orH && d.c[k] < d.o[k]) return { k, side: 'short', stop: maxOf(d.h, k - 2, k) * 1.001, target: mid, rs: 0, minReward: 1.5 };
      if (brokeDn && d.c[k] > orL && d.c[k] > d.o[k]) return { k, side: 'long', stop: minOfArr(d.l, k - 2, k) * 0.999, target: mid, rs: 0, minReward: 1.5 };
    }
    return null;
  }
};

// ---------------- executor ----------------
function simulate(d, sig, policy) {
  const dir = sig.side === 'long' ? 1 : -1;
  const entry = d.c[sig.k] * (1 + dir * SLIP);
  let stop = sig.stop;
  const dist = Math.abs(entry - stop);
  if (!(dist > 0) || dist < 0.004 * entry || dist > 0.015 * entry) return null;
  if (dir === 1 ? stop >= entry : stop <= entry) return null;
  const target = sig.target != null ? sig.target : entry + dir * RR * dist;
  if (sig.target != null && dir * (target - entry) < sig.minReward * dist) return null;
  const qty = Math.floor(Math.min(RISK / dist, MAXVAL / entry));
  if (qty < 1) return null;
  let be = false, exit = null, reason = '', jx = d.n - 1;
  for (let j = sig.k + 1; j < d.n; j++) {
    if (d.c[j] === undefined) break;
    if (startMin(j) >= SQ) { exit = d.o[j]; reason = 'close'; jx = j; break; }
    if (dir === 1 ? d.l[j] <= stop : d.h[j] >= stop) { exit = (dir === 1 ? Math.min(d.o[j], stop) : Math.max(d.o[j], stop)) * (1 - dir * SLIP); reason = be ? 'breakeven' : 'stop'; jx = j; break; }
    if (dir === 1 ? d.h[j] >= target : d.l[j] <= target) { exit = dir === 1 ? Math.max(d.o[j], target) : Math.min(d.o[j], target); reason = 'target'; jx = j; break; }
    if (policy === 'P2' && !be && (dir === 1 ? d.h[j] >= entry + dist : d.l[j] <= entry - dist)) { stop = entry; be = true; }
  }
  if (exit === null) { jx = d.n - 1; while (d.c[jx] === undefined) jx--; exit = d.c[jx]; reason = 'close'; }
  const gross = (exit - entry) * dir * qty;
  const fee = charges(dir === 1 ? 'BUY' : 'SELL', qty * entry) + charges(dir === 1 ? 'SELL' : 'BUY', qty * exit);
  const net = gross - fee;
  return { side: sig.side, kIn: sig.k, kOut: jx, entry, exit, qty, dist, gross, fee, net, R: net / (dist * qty), reason, rs: sig.rs };
}

// ---------------- statistics ----------------
function stats(tr) {
  const n = tr.length;
  if (!n) return { n: 0 };
  const gR = mean(tr.map(t => t.gross / (t.dist * t.qty)));
  const R = tr.map(t => t.R), m = mean(R), sd = Math.sqrt(mean(R.map(x => (x - m) ** 2)));
  const gw = tr.filter(t => t.net > 0).reduce((a, t) => a + t.net, 0), gl = -tr.filter(t => t.net <= 0).reduce((a, t) => a + t.net, 0);
  let cum = 0, pk = 0, dd = 0;
  for (const t of tr.slice().sort((a, b) => a.day.localeCompare(b.day) || a.kIn - b.kIn)) { cum += t.net; pk = Math.max(pk, cum); dd = Math.max(dd, pk - cum); }
  return { gR, n, win: tr.filter(t => t.net > 0).length / n * 100, avgR: m, t: sd > 0 ? m / (sd / Math.sqrt(n)) : 0, pf: gl > 0 ? gw / gl : Infinity, net: tr.reduce((a, t) => a + t.net, 0), fees: tr.reduce((a, t) => a + t.fee, 0), dd, sessions: new Set(tr.map(t => t.day)).size };
}
// first-come portfolio: at most 3 open and 6 trades a day
function portfolio(tr) {
  const out = [], byDay = {};
  for (const t of tr) (byDay[t.day] = byDay[t.day] || []).push(t);
  for (const day of Object.keys(byDay).sort()) {
    const list = byDay[day].sort((a, b) => a.kIn - b.kIn || b.rs - a.rs), open = [];
    let taken = 0;
    for (const t of list) {
      for (let i = open.length - 1; i >= 0; i--) if (open[i] <= t.kIn) open.splice(i, 1);
      if (open.length >= MAXPOS || taken >= MAXTRADES) continue;
      open.push(t.kOut); taken++; out.push(t);
    }
  }
  return out;
}
const f = (x, d = 2) => (x === Infinity ? 'inf' : Number(x).toFixed(d));
const row = (name, s) => s.n ? `${name.padEnd(22)} n=${String(s.n).padStart(4)} win ${f(s.win, 0).padStart(3)}%  avgR ${f(s.avgR).padStart(6)}  grossR ${f(s.gR).padStart(6)}  t ${f(s.t, 1).padStart(5)}  PF ${f(s.pf).padStart(5)}  net ${f(s.net, 0).padStart(7)}  fees ${f(s.fees, 0).padStart(6)}  maxDD ${f(s.dd, 0).padStart(6)}` : `${name.padEnd(22)} no trades`;

// ---------------- run ----------------
(async () => {
  const syms = base.watchlist.slice();
  console.log(`Loading 5-minute and daily history for ${syms.length} stocks and Nifty (cached after the first run)...`);
  const { five, daily } = await loadAll([base.indexSymbol, ...syms]);
  console.log(`  loaded ${Object.keys(five).length} symbols`.padEnd(40));
  const nb = five[base.indexSymbol];
  const nDays = {};
  for (const b of nb) (nDays[dayKey(b.t)] = nDays[dayKey(b.t)] || []).push(b);
  const sessions = Object.keys(nDays).filter(k => nDays[k].length >= 74).sort();
  const maxPrice = base.capital * base.leverage * (base.maxAllocPct / 100);
  console.log(`${sessions.length} sessions: ${sessions[0]} to ${sessions[sessions.length - 1]}\n`);

  const names = ONLY ? [ONLY] : Object.keys(STRATS);
  const trades = {}; for (const s of names) trades[s] = { P1: [], P2: [] };
  const bySym = {};
  for (const s of syms) if (five[s]) { bySym[s] = {}; for (const b of five[s]) (bySym[s][dayKey(b.t)] = bySym[s][dayKey(b.t)] || []).push(b); }
  let eligibleTotal = 0;
  for (const day of sessions) {
    const nArr = { o: [], c: [] };
    nArr.up = []; let nsum = 0;
    for (const b of nDays[day]) { const k = (minOfDay(b.t) - OPEN) / 5; if (Number.isInteger(k) && k >= 0 && k < 75) { nArr.o[k] = b.o; nArr.c[k] = b.c; nsum += (b.h + b.l + b.c) / 3; nArr.up[k] = b.c > nsum / (k + 1); } }
    for (const s of syms) {
      if (!bySym[s] || !bySym[s][day] || !daily[s]) continue;
      const hist = daily[s].filter(c => dayKey(c.t) < day);
      const info = analyzeDaily(s, hist);
      if (!info || info.atrPct < base.minAtrPct || info.atrPct > base.maxAtrPct || info.turnover < base.minTurnover || info.close > maxPrice) continue;
      const d = buildDay(bySym[s][day], nArr);
      if (!d) continue;
      eligibleTotal++;
      for (const name of names) {
        d.key = s + day;
        const sig = STRATS[name](d, info);
        if (!sig) continue;
        for (const pol of ['P1', 'P2']) { const t = simulate(d, sig, pol); if (t) trades[name][pol].push({ ...t, day, sym: s, strat: name, policy: pol }); }
      }
    }
  }
  console.log(`${eligibleTotal} eligible stock-days scanned\n`);

  const mid = sessions[Math.floor(sessions.length / 2)];
  const summary = {};
  for (const name of names) {
    console.log(`==== ${name} ====`);
    for (const pol of ['P1', 'P2']) {
      const all = trades[name][pol];
      const first = all.filter(t => t.day < mid), second = all.filter(t => t.day >= mid);
      console.log(row(`${pol} every signal`, stats(all)));
      console.log(row(`${pol}   first half`, stats(first)) + '\n' + row(`${pol}   second half`, stats(second)));
      console.log(row(`${pol} long`, stats(all.filter(t => t.side === 'long'))) + '\n' + row(`${pol} short`, stats(all.filter(t => t.side === 'short'))));
      console.log(row(`${pol} PORTFOLIO (3 open, 6/day)`, stats(portfolio(all))));
      summary[`${name}.${pol}`] = { all: stats(all), first: stats(first), second: stats(second), portfolio: stats(portfolio(all)) };
    }
    console.log();
  }
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'data', 'lab-results.json'), JSON.stringify({ sessions, summary, trades }, null, 0));
  console.log('Saved data/lab-results.json (every simulated trade, for later analysis).');

  console.log('\nRANKING (policy P2, net of costs; consistent = positive avgR in BOTH halves and t >= 2):');
  const rank = Object.entries(summary).filter(([k]) => k.endsWith('.P2')).map(([k, v]) => ({ k, ...v })).sort((a, b) => (b.all.avgR || -9) - (a.all.avgR || -9));
  for (const r of rank) {
    const consistent = r.first.n && r.second.n && r.first.avgR > 0 && r.second.avgR > 0 && r.all.t >= 2;
    console.log(`  ${r.k.padEnd(22)} n=${String(r.all.n || 0).padStart(4)} avgR ${f(r.all.avgR || 0).padStart(6)} (halves ${f(r.first.avgR || 0)} / ${f(r.second.avgR || 0)}) t ${f(r.all.t || 0, 1).padStart(5)}  ${consistent ? 'CONSISTENT' : 'not consistent'}`);
  }
})().catch(e => { console.error('LAB ERROR', e.stack); process.exit(1); });
