// Pre-registered factor test on NIFTY 200 daily data (see lib/factors.js for the formulas).
//   node factor-test.js --dir data/fyers-daily
// FROZEN PROTOCOL (written before any result was seen; do not change it after looking):
//   timing    signal from the previous close; buy at the first session's open of each week, sell at next week's open
//   universe  stocks with 260+ sessions of history, 20-day average turnover >= Rs 30 crore, no one-day move over 35% in the window
//   measures  rank IC with the next week's return; top-fifth return minus the universe average ("excess"), gross and after
//             a 0.31% round-trip delivery cost charged every week (full turnover assumed, which is conservative)
//   split     development: weeks starting up to 2022-12-31; holdout: from 2023-01-01
//   pass      positive IC AND positive after-cost excess in BOTH periods, holdout IC t-stat >= 2.0, and a combined sign-flip
//             p-value below 0.05 after adjusting for the 10 real factors (the RANDOM control is not counted)
// SURVIVORSHIP: the universe is today's NIFTY 200, so stocks that rose into the index are over-represented. Excess over the
// universe average removes the level of that bias but not all of it. Treat any pass as a lead, not proof.
const fs = require('fs');
const path = require('path');
const F = require('./lib/factors');
const V = require('./lib/validate');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const dir = arg('dir', 'data/fyers-daily');
const DEV_END = '2022-12-31', COST = 0.0031, MIN_TURNOVER = 3e8, TOP = 0.2, TESTS = 10;

// ---------- load and align every stock on the NIFTY calendar ----------
const raw = {};
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.csv')) continue;
  raw[f.slice(0, -4)] = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').slice(1).map(l => l.split(',')).map(r => ({ d: r[0].slice(0, 10), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
}
const cal = raw.NIFTY.map(r => r.d), T = cal.length, ci = new Map(cal.map((d, i) => [d, i]));
const syms = Object.keys(raw).filter(s => s !== 'NIFTY' && s !== 'INDIAVIX');
const P = { open: [], high: [], low: [], close: [], volume: [] };
for (const s of syms) {
  const row = { open: new Array(T).fill(NaN), high: new Array(T).fill(NaN), low: new Array(T).fill(NaN), close: new Array(T).fill(NaN), volume: new Array(T).fill(NaN) };
  for (const r of raw[s]) { const t = ci.get(r.d); if (t == null || !(r.c > 0)) continue; row.open[t] = r.o; row.high[t] = r.h; row.low[t] = r.l; row.close[t] = r.c; row.volume[t] = r.v; }
  for (const k of Object.keys(P)) P[k].push(row[k]);
}
console.log(`${syms.length} stocks, ${T} sessions (${cal[0]} to ${cal[T - 1]})`);

// ---------- weekly rebalance dates ----------
const wk = d => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); return t.getUTCFullYear() * 100 + Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7); };
const starts = []; for (let t = 1; t < T; t++) if (wk(cal[t]) !== wk(cal[t - 1])) starts.push(t);

// ---------- eligibility and forward returns per week ----------
const weeks = [];
for (let w = 0; w + 1 < starts.length; w++) {
  const x = starts[w], xe = starts[w + 1];
  if (x < 262) continue;
  const elig = [], fr = [];
  for (let i = 0; i < syms.length; i++) {
    const o0 = P.open[i][x], o1 = P.open[i][xe];
    if (!(o0 > 0) || !(o1 > 0) || !Number.isFinite(P.close[i][x - 1]) || !Number.isFinite(P.close[i][x - 253])) continue;
    let turn = 0, ok = true;
    for (let t = x - 20; t < x; t++) { const c = P.close[i][t], v = P.volume[i][t]; if (!Number.isFinite(c) || !Number.isFinite(v)) { ok = false; break; } turn += c * v; }
    if (!ok || turn / 20 < MIN_TURNOVER) continue;
    let art = false; for (let t = x - 252; t <= xe && !art; t++) { const a = P.close[i][t], b = P.close[i][t - 1]; if (a > 0 && b > 0 && Math.abs(a / b - 1) > 0.35) art = true; }
    if (art) continue;
    elig.push(i); fr.push(o1 / o0 - 1);
  }
  if (elig.length >= 40) weeks.push({ day: cal[x], x, elig, fr });
}
console.log(`${weeks.length} weekly rebalances (${weeks[0].day} to ${weeks[weeks.length - 1].day}), ${Math.round(weeks.reduce((a, w) => a + w.elig.length, 0) / weeks.length)} stocks per week on average\n`);

// ---------- run every factor ----------
const mean = V.mean, sd = V.sd, f2 = (v, d = 2) => (v == null || !isFinite(v) ? '-' : v.toFixed(d));
const tstat = a => (a.length > 2 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : NaN);
const results = [];
for (const [name, def] of Object.entries(F.FACTORS)) {
  const M = def.f(P), rows = [];
  for (const w of weeks) {
    const vals = w.elig.map(i => M[i][w.x - 1]);
    const ic = F.spearman(vals, w.fr);
    const order = vals.map((v, k) => [v, k]).filter(p => Number.isFinite(p[0])).sort((a, b) => b[0] - a[0]);
    if (order.length < 30 || !Number.isFinite(ic)) continue;
    const n = Math.max(1, Math.ceil(order.length * TOP)), uni = mean(order.map(p => w.fr[p[1]]));
    const top = mean(order.slice(0, n).map(p => w.fr[p[1]])), bot = mean(order.slice(-n).map(p => w.fr[p[1]]));
    rows.push({ day: w.day, ic, ex: top - uni, exNet: top - uni - COST, botEx: bot - uni });
  }
  const dev = rows.filter(r => r.day <= DEV_END), ho = rows.filter(r => r.day > DEV_END);
  const sf = V.signFlipTest(rows.map(r => r.exNet), rows.map(r => r.day));
  const adj = V.sidak(sf.p, TESTS);
  const pass = dev.length && ho.length && mean(dev.map(r => r.ic)) > 0 && mean(ho.map(r => r.ic)) > 0 && mean(dev.map(r => r.exNet)) > 0 && mean(ho.map(r => r.exNet)) > 0 && tstat(ho.map(r => r.ic)) >= 2 && adj < 0.05;
  results.push({ name, src: def.src, dev, ho, rows, sf, adj, pass });
}

const hdr = 'factor     period        weeks   mean IC   IC t    top-fifth excess/wk   after costs   bottom-fifth excess';
console.log(hdr);
for (const r of results) {
  for (const [label, part] of [['development', r.dev], ['holdout', r.ho]]) {
    console.log(`${(label === 'development' ? r.name : '').padEnd(10)} ${label.padEnd(12)} ${String(part.length).padStart(5)}   ${f2(mean(part.map(x => x.ic)), 4).padStart(7)}  ${f2(tstat(part.map(x => x.ic)), 1).padStart(5)}    ${(f2(mean(part.map(x => x.ex)) * 100, 3) + '%').padStart(10)}        ${(f2(mean(part.map(x => x.exNet)) * 100, 3) + '%').padStart(10)}    ${(f2(mean(part.map(x => x.botEx)) * 100, 3) + '%').padStart(10)}`);
  }
}
console.log('\nVerdicts (after-cost excess, combined periods, sign-flip p adjusted for 10 factors):');
for (const r of results) console.log(`  ${r.name.padEnd(9)} ${r.src.padEnd(26)} p = ${f2(r.sf.p, 4)}  adjusted p = ${f2(r.adj, 4)}   ${r.name === 'RANDOM' ? 'control' : r.pass ? 'PASSES the frozen rule' : 'does not pass'}`);
const passed = results.filter(r => r.pass && r.name !== 'RANDOM');
console.log(`\n${passed.length} of 10 factors pass. The random control shows mean IC ${f2(mean(results.find(r => r.name === 'RANDOM').rows.map(x => x.ic)), 4)} (should be near 0).`);
