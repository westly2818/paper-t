// Long-history swing study on daily Fyers data (about 10 years). Three candidates, defined in advance:
//   M1 monthly 12-1 momentum, top 10, cash when Nifty < 200DMA
//   M2 weekly 5-day reversal in uptrends (5 worst, above 50DMA), 1-week hold
//   M3 Donchian trend following: close above the 55-day high, exit below the 20-day low or 2.5 ATR stop, Nifty above 200DMA only
// Delivery charges (STT 0.1% each side), 0.05% slippage per side, Rs 20,000 per position.
// SURVIVORSHIP BIAS: the universe is today's NIFTY 200 members, so past losers that dropped out are missing. Results are optimistic.
//   node swing-study.js --dir data/fyers-daily
const fs = require('fs');
const path = require('path');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const dir = arg('dir', 'data/fyers-daily'), DEV_END = '2022-12-31', POS = 20000, SLIP = 0.0005;

const S = {};
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.csv')) continue;
  const rows = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').slice(1).map(l => l.split(','));
  const d = rows.map(r => r[0].slice(0, 10)), o = rows.map(r => +r[1]), h = rows.map(r => +r[2]), l = rows.map(r => +r[3]), c = rows.map(r => +r[4]), v = rows.map(r => +r[5]);
  S[f.slice(0, -4)] = { d, o, h, l, c, v, idx: new Map(d.map((x, i) => [x, i])) };
}
const N = S.NIFTY; delete S.NIFTY; delete S.INDIAVIX;
const syms = Object.keys(S), cal = N.d;
console.log(`${syms.length} stocks, calendar ${cal[0]} to ${cal[cal.length - 1]} (${cal.length} sessions)\n`);

const delivery = (side, v) => { const brk = Math.min(20, v * 0.0003), stt = v * 0.001, txn = v * 0.0000297, sebi = v * 0.000001, stamp = side === 'BUY' ? v * 0.00015 : 0; return brk + stt + txn + sebi + stamp + 0.18 * (brk + txn + sebi); };
const sma = (a, end, n) => { let s = 0; for (let q = end - n; q < end; q++) s += a[q]; return s / n; };
const niftyOn = i => i >= 200 && N.c[i - 1] > sma(N.c, i, 200);
function artifact(s, from, to) { for (let q = Math.max(1, from); q <= to; q++) if (Math.abs(s.c[q] / s.c[q - 1] - 1) > 0.35) return true; return false; }
function tradeNet(entryPx, exitPx) { const e = entryPx * (1 + SLIP), x = exitPx * (1 - SLIP), qty = POS / e; return { net: (x - e) * qty - delivery('BUY', qty * e) - delivery('SELL', qty * x), ret: 0, e, x, qty }; }
const rec = (sym, entryDay, exitDay, ep, xp, why) => { const t = tradeNet(ep, xp); return { sym, day: entryDay, exitDay, net: t.net, ret: t.net / POS, why }; };

// ---------- period starts ----------
const firstOf = keyFn => { const out = []; let prev = null; for (let i = 0; i < cal.length; i++) { const k = keyFn(cal[i]); if (k !== prev) out.push(i); prev = k; } return out; };
const month = d => d.slice(0, 7);
const week = d => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); return t.getUTCFullYear() * 100 + Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7); };

function periodic(starts, pick, regime) {
  const trades = [], periods = [];
  for (let w = 0; w + 1 < starts.length; w++) {
    const i = starts[w], j = starts[w + 1];
    if (i < 260) continue;
    const day = cal[i];
    const el = [];
    for (const sym of syms) {
      const s = S[sym], x = s.idx.get(day), xe = s.idx.get(cal[j]);
      if (x == null || xe == null || x < 260) continue;
      let turn = 0; for (let q = x - 20; q < x; q++) turn += s.c[q] * s.v[q]; turn /= 20;
      if (turn < 3e8 || s.c[x - 1] > 8000 || artifact(s, x - 253, xe)) continue;
      el.push({ sym, s, x, xe, mom: s.c[x - 22] / s.c[x - 253] - 1, ret5: s.c[x - 1] / s.c[x - 6] - 1, above50: s.c[x - 1] > sma(s.c, x, 50) });
    }
    if (el.length < 20) continue;
    const bench = el.reduce((a, e) => a + (e.s.o[e.xe] / e.s.o[e.x] - 1), 0) / el.length;
    const on = regime ? niftyOn(i) : true;
    let ret = 0;
    if (on) {
      const picks = pick(el);
      const tr = picks.map(e => rec(e.sym, day, cal[j], e.s.o[e.x], e.s.o[e.xe], 'period'));
      trades.push(...tr);
      ret = tr.reduce((a, t) => a + t.ret, 0) / Math.max(1, tr.length);
    }
    periods.push({ day, ret, bench, on });
  }
  return { trades, periods };
}
const m1 = periodic(firstOf(month), el => el.sort((a, b) => b.mom - a.mom).slice(0, 10), true);
const m2 = periodic(firstOf(week), el => el.filter(e => e.above50 && e.ret5 >= -0.12).sort((a, b) => a.ret5 - b.ret5).slice(0, 5), false);

// ---------- M3 Donchian ----------
const m3 = [];
for (const sym of syms) {
  const s = S[sym];
  let inPos = null;
  for (let q = 260; q < s.d.length - 1; q++) {
    const ni = N.idx.get(s.d[q]);
    if (inPos) {
      let low20 = Infinity; for (let z = q - 20; z < q; z++) low20 = Math.min(low20, s.l[z]);
      if (s.l[q] <= inPos.stop) { m3.push(rec(sym, inPos.day, s.d[q], inPos.ep, Math.min(s.o[q], inPos.stop), 'stop')); inPos = null; }
      else if (s.c[q] < low20) { m3.push(rec(sym, inPos.day, s.d[q + 1], inPos.ep, s.o[q + 1], 'channel exit')); inPos = null; }
      continue;
    }
    if (ni == null || !niftyOn(ni)) continue;
    let hi55 = -Infinity; for (let z = q - 55; z < q; z++) hi55 = Math.max(hi55, s.h[z]);
    let turn = 0; for (let z = q - 20; z < q; z++) turn += s.c[z] * s.v[z]; turn /= 20;
    if (s.c[q] > hi55 && turn >= 3e8 && s.c[q] < 8000 && !artifact(s, q - 60, q)) {
      let tr = 0; for (let z = q - 14; z < q; z++) tr += Math.max(s.h[z] - s.l[z], Math.abs(s.h[z] - s.c[z - 1]), Math.abs(s.l[z] - s.c[z - 1]));
      const atr = tr / 14, ep = s.o[q + 1];
      inPos = { day: s.d[q + 1], ep, stop: ep - 2.5 * atr };
    }
  }
}

// ---------- reporting ----------
const f2 = (v, d = 2) => (v == null || !isFinite(v) ? '-' : v.toFixed(d));
function tstat(tr) {
  const n = tr.length; if (!n) return null;
  const m = tr.reduce((a, t) => a + t.ret, 0) / n, sd = Math.sqrt(tr.reduce((a, t) => a + (t.ret - m) ** 2, 0) / Math.max(1, n - 1));
  const gw = tr.filter(t => t.net > 0).reduce((a, t) => a + t.net, 0), gl = -tr.filter(t => t.net <= 0).reduce((a, t) => a + t.net, 0);
  return { n, m, ci: 1.96 * sd / Math.sqrt(n), win: tr.filter(t => t.net > 0).length / n * 100, pf: gl > 0 ? gw / gl : Infinity };
}
const lineT = (label, tr) => { const s = tstat(tr); console.log(s ? `  ${label.padEnd(12)} trades ${String(s.n).padStart(5)}  avg net ${f2(s.m * 100)}% per trade (+/-${f2(s.ci * 100)})  win ${f2(s.win, 0)}%  PF ${f2(s.pf)}` : `  ${label.padEnd(12)} none`); };
function linePeriods(label, ps, perYear) {
  if (!ps.length) return console.log(`  ${label.padEnd(12)} none`);
  const n = ps.length, mean = ps.reduce((a, p) => a + p.ret, 0) / n, bm = ps.reduce((a, p) => a + p.bench, 0) / n;
  const sd = Math.sqrt(ps.reduce((a, p) => a + (p.ret - mean) ** 2, 0) / Math.max(1, n - 1));
  let eq = 1, peak = 1, dd = 0, beq = 1; for (const p of ps) { eq *= 1 + p.ret; beq *= 1 + p.bench; peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak); }
  const yrs = n / perYear;
  console.log(`  ${label.padEnd(12)} periods ${String(n).padStart(4)} (in market ${ps.filter(p => p.on).length})  strategy ${f2(mean * 100)}%/period vs universe ${f2(bm * 100)}%/period (no costs)  excess ${f2((mean - bm) * 100)}% (+/-${f2(1.96 * sd / Math.sqrt(n) * 100)})  CAGR ${f2((Math.pow(eq, 1 / yrs) - 1) * 100, 1)}% vs ${f2((Math.pow(beq, 1 / yrs) - 1) * 100, 1)}%  max drawdown ${f2(dd * 100, 0)}%`);
}
const split = (a, key = 'day') => [a.filter(x => x[key] <= DEV_END), a.filter(x => x[key] > DEV_END)];
function blockP(name, r, perYear) {
  console.log(name);
  const [d1, d2] = [split(r.trades)[0], split(r.trades)[1]], [p1, p2] = split(r.periods);
  lineT('development', d1); lineT('holdout', d2); lineT('all', r.trades);
  linePeriods('development', p1, perYear); linePeriods('holdout', p2, perYear); linePeriods('all', r.periods, perYear);
  console.log();
}
blockP('M1 monthly 12-1 momentum, top 10, cash when Nifty < 200DMA', m1, 12);
blockP('M2 weekly 5-day reversal in uptrends, 5 positions', m2, 52);
console.log('M3 Donchian trend following (55-day high entry, 20-day low / 2.5 ATR exit, Nifty > 200DMA)');
lineT('development', split(m3)[0]); lineT('holdout', split(m3)[1]); lineT('all', m3);
const byYear = {}; for (const t of m3) (byYear[t.day.slice(0, 4)] = byYear[t.day.slice(0, 4)] || []).push(t);
console.log('  per year: ' + Object.entries(byYear).map(([y, a]) => `${y}: ${a.length} trades ${f2(a.reduce((s, t) => s + t.ret, 0) / a.length * 100)}%`).join(' | '));
const hold = m3.map(t => (Date.parse(t.exitDay) - Date.parse(t.day)) / 86400000);
console.log(`  average holding ${f2(hold.reduce((a, b) => a + b, 0) / hold.length, 0)} calendar days`);
const nb = N.c[N.c.length - 1] / N.c[260] - 1;
console.log(`\nNifty buy-and-hold ${cal[260]} to ${cal[cal.length - 1]}: ${f2(nb * 100, 0)}% (${f2((Math.pow(1 + nb, 365 / ((Date.parse(cal[cal.length - 1]) - Date.parse(cal[260])) / 86400000)) - 1) * 100, 1)}% a year)`);

// ================= extra checks added before trusting M3 =================
// (a) excess of each M3 trade over the equal-weight universe for the same dates; (b) a 10-slot portfolio version for a small account.
const U = new Float64Array(cal.length); U[0] = 1;
for (let i = 1; i < cal.length; i++) {
  let sum = 0, cnt = 0;
  for (const sym of syms) { const s = S[sym], q = s.idx.get(cal[i]), p = s.idx.get(cal[i - 1]); if (q == null || p == null) continue; const r = s.c[q] / s.c[p] - 1; if (Math.abs(r) > 0.35) continue; sum += r; cnt++; }
  U[i] = U[i - 1] * (1 + (cnt ? sum / cnt : 0));
}
const ci = new Map(cal.map((d, i) => [d, i]));
const ex = m3.map(t => { const a = ci.get(t.day), b = ci.get(t.exitDay); return a == null || b == null ? null : { day: t.day, ret: t.ret - (U[b - 1] / U[a - 1] - 1) }; }).filter(Boolean);
const exStat = a => { const n = a.length, m = a.reduce((x, t) => x + t.ret, 0) / n, sd = Math.sqrt(a.reduce((x, t) => x + (t.ret - m) ** 2, 0) / (n - 1)); return `n=${n}  excess over universe ${f2(m * 100)}% per trade (+/-${f2(1.96 * sd / Math.sqrt(n) * 100)})`; };
console.log('\nM3 excess over the equal-weight universe for the same holding dates:');
console.log('  development ' + exStat(split(ex)[0])); console.log('  holdout     ' + exStat(split(ex)[1])); console.log('  all         ' + exStat(ex));

function portfolio(slots, startCap) {
  let cash = startCap, pos = [], pendExit = new Set(), pend = [];
  const curve = [];
  for (let i = 261; i < cal.length; i++) {
    const day = cal[i];
    // open of today: exits decided yesterday, then entries decided yesterday
    for (const p of pos.slice()) if (pendExit.has(p.sym)) { const s = S[p.sym], q = s.idx.get(day); if (q == null) continue; const x = s.o[q] * (1 - SLIP); cash += p.qty * x - delivery('SELL', p.qty * x); pos = pos.filter(z => z !== p); pendExit.delete(p.sym); }
    let eq = cash; for (const p of pos) { const s = S[p.sym], q = s.idx.get(day); eq += p.qty * (q != null ? s.o[q] : p.last); }
    for (const sg of pend) {
      if (pos.length >= slots || pos.some(z => z.sym === sg.sym)) continue;
      const s = S[sg.sym], q = s.idx.get(day); if (q == null) continue;
      const ep = s.o[q] * (1 + SLIP), qty = Math.floor((eq / slots) / ep);
      if (qty < 1 || qty * ep + delivery('BUY', qty * ep) > cash) continue;
      cash -= qty * ep + delivery('BUY', qty * ep);
      pos.push({ sym: sg.sym, qty, ep, stop: ep - 2.5 * sg.atr, last: ep });
    }
    pend = [];
    // intraday stop hits today
    for (const p of pos.slice()) { const s = S[p.sym], q = s.idx.get(day); if (q == null) continue; if (s.l[q] <= p.stop) { const x = Math.min(s.o[q], p.stop) * (1 - SLIP); cash += p.qty * x - delivery('SELL', p.qty * x); pos = pos.filter(z => z !== p); } }
    // close: channel exits for tomorrow, mark, new signals for tomorrow
    let mark = cash;
    for (const p of pos) {
      const s = S[p.sym], q = s.idx.get(day); if (q == null) { mark += p.qty * p.last; continue; }
      p.last = s.c[q]; mark += p.qty * s.c[q];
      let low20 = Infinity; for (let z = q - 20; z < q; z++) low20 = Math.min(low20, s.l[z]);
      if (s.c[q] < low20) pendExit.add(p.sym);
    }
    curve.push({ day, eq: mark });
    if (niftyOn(i)) {
      const sigs = [];
      for (const sym of syms) {
        const s = S[sym], q = s.idx.get(day); if (q == null || q < 260 || pos.some(z => z.sym === sym)) continue;
        let hi55 = -Infinity; for (let z = q - 55; z < q; z++) hi55 = Math.max(hi55, s.h[z]);
        if (!(s.c[q] > hi55) || s.c[q] >= 8000) continue;
        let turn = 0; for (let z = q - 20; z < q; z++) turn += s.c[z] * s.v[z]; turn /= 20;
        if (turn < 3e8 || artifact(s, q - 60, q)) continue;
        let tr = 0; for (let z = q - 14; z < q; z++) tr += Math.max(s.h[z] - s.l[z], Math.abs(s.h[z] - s.c[z - 1]), Math.abs(s.l[z] - s.c[z - 1]));
        sigs.push({ sym, atr: tr / 14, strength: s.c[q] / hi55 - 1 });
      }
      pend = sigs.sort((a, b) => b.strength - a.strength);
    }
  }
  return curve;
}
function curveStats(label, curve, from, to) {
  const c = curve.filter(p => p.day >= from && p.day <= to); if (c.length < 20) return;
  let peak = 0, dd = 0; for (const p of c) { peak = Math.max(peak, p.eq); dd = Math.max(dd, 1 - p.eq / peak); }
  const yrs = (Date.parse(c[c.length - 1].day) - Date.parse(c[0].day)) / (365 * 86400000), tot = c[c.length - 1].eq / c[0].eq;
  const a = ci.get(c[0].day), b = ci.get(c[c.length - 1].day);
  const uni = U[b] / U[a], nif = N.c[b] / N.c[a];
  console.log(`  ${label.padEnd(24)} ${from} to ${to}: strategy ${f2((Math.pow(tot, 1 / yrs) - 1) * 100, 1)}%/yr (max drawdown ${f2(dd * 100, 0)}%)   universe ${f2((Math.pow(uni, 1 / yrs) - 1) * 100, 1)}%/yr   Nifty ${f2((Math.pow(nif, 1 / yrs) - 1) * 100, 1)}%/yr`);
}
console.log('\nM3 as a 10-slot portfolio, Rs 20,000 start, strongest breakouts first:');
const pc = portfolio(10, 20000);
curveStats('development', pc, '2017-10-12', DEV_END); curveStats('holdout', pc, '2023-01-01', '2026-10-01'); curveStats('whole period', pc, '2017-10-12', '2026-10-01');
const pc5 = portfolio(5, 20000);
console.log('M3 with 5 slots:');
curveStats('development', pc5, '2017-10-12', DEV_END); curveStats('holdout', pc5, '2023-01-01', '2026-10-01'); curveStats('whole period', pc5, '2017-10-12', '2026-10-01');
