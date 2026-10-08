// Cross-sectional factor tools. A "panel" is { field: [stockIndex][dateIndex] } (NaN where missing).
// Formulas are the published ones (Kakushadze, "101 Formulaic Alphas", arXiv:1601.00991) as implemented in the
// Vibe-Trading alpha zoo, ported to JavaScript. rank = cross-sectional percentile rank on each date.
const nan = NaN;

const delta = (x, d) => x.map((row) => row.map((v, t) => (t >= d ? v - row[t - d] : nan)));
const map2 = (a, b, f) => a.map((row, i) => row.map((v, t) => f(v, b[i][t])));
const map1 = (a, f) => a.map(row => row.map(v => f(v)));

function csRank(m) {                     // percentile rank of each stock among the stocks present on that date
  const S = m.length, T = m[0].length, out = m.map(() => new Array(T).fill(nan));
  for (let t = 0; t < T; t++) {
    const idx = [];
    for (let i = 0; i < S; i++) if (Number.isFinite(m[i][t])) idx.push(i);
    idx.sort((p, q) => m[p][t] - m[q][t]);
    let k = 0;
    while (k < idx.length) {            // ties share the average rank
      let e = k; while (e + 1 < idx.length && m[idx[e + 1]][t] === m[idx[k]][t]) e++;
      const r = (k + e) / 2 + 1;
      for (let z = k; z <= e; z++) out[idx[z]][t] = r / idx.length;
      k = e + 1;
    }
  }
  return out;
}

function tsCorr(a, b, n) {               // rolling correlation over the last n observations, per stock
  return a.map((row, i) => row.map((_, t) => {
    if (t < n - 1) return nan;
    let sa = 0, sb = 0;
    for (let k = t - n + 1; k <= t; k++) { const x = row[k], y = b[i][k]; if (!Number.isFinite(x) || !Number.isFinite(y)) return nan; sa += x; sb += y; }
    const ma = sa / n, mb = sb / n;
    let c = 0, va = 0, vb = 0;
    for (let k = t - n + 1; k <= t; k++) { const x = row[k] - ma, y = b[i][k] - mb; c += x * y; va += x * x; vb += y * y; }
    return va > 0 && vb > 0 ? c / Math.sqrt(va * vb) : nan;
  }));
}

function tsStd(a, n) {
  return a.map(row => row.map((_, t) => {
    if (t < n - 1) return nan;
    let s = 0; for (let k = t - n + 1; k <= t; k++) { if (!Number.isFinite(row[k])) return nan; s += row[k]; }
    const m = s / n; let v = 0; for (let k = t - n + 1; k <= t; k++) v += (row[k] - m) ** 2;
    return Math.sqrt(v / (n - 1));
  }));
}

// Spearman rank correlation between two vectors (NaN pairs dropped)
function spearman(x, y) {
  const idx = []; for (let i = 0; i < x.length; i++) if (Number.isFinite(x[i]) && Number.isFinite(y[i])) idx.push(i);
  const n = idx.length; if (n < 10) return nan;
  const rk = v => { const o = idx.slice().sort((p, q) => v[p] - v[q]), r = {}; let k = 0; while (k < n) { let e = k; while (e + 1 < n && v[o[e + 1]] === v[o[k]]) e++; for (let z = k; z <= e; z++) r[o[z]] = (k + e) / 2; k = e + 1; } return r; };
  const rx = rk(x), ry = rk(y); let sx = 0, sy = 0; for (const i of idx) { sx += rx[i]; sy += ry[i]; }
  const mx = sx / n, my = sy / n; let c = 0, vx = 0, vy = 0;
  for (const i of idx) { const a = rx[i] - mx, b = ry[i] - my; c += a * b; vx += a * a; vy += b * b; }
  return vx > 0 && vy > 0 ? c / Math.sqrt(vx * vy) : nan;
}

// The pre-registered factors. Each takes the panel and returns a [stock][date] matrix (higher = expected to do better).
const FACTORS = {
  A2: { src: 'Kakushadze #2', f: P => map1(tsCorr(csRank(delta(map1(P.volume, v => (v > 0 ? Math.log(v) : nan)), 2)), csRank(map2(P.close, P.open, (c, o) => (c - o) / o)), 6), v => -v) },
  A3: { src: 'Kakushadze #3', f: P => map1(tsCorr(csRank(P.open), csRank(P.volume), 10), v => -v) },
  A6: { src: 'Kakushadze #6', f: P => map1(tsCorr(P.open, P.volume, 10), v => -v) },
  A12: { src: 'Kakushadze #12', f: P => map2(delta(P.volume, 1), delta(P.close, 1), (dv, dc) => Math.sign(dv) * -dc) },
  A33: { src: 'Kakushadze #33', f: P => csRank(map2(P.open, P.close, (o, c) => -(1 - o / c))) },
  A44: { src: 'Kakushadze #44', f: P => map1(tsCorr(P.high, csRank(P.volume), 5), v => -v) },
  A101: { src: 'Kakushadze #101', f: P => P.close.map((row, i) => row.map((c, t) => (c - P.open[i][t]) / (P.high[i][t] - P.low[i][t] + 0.001))) },
  MOM12_1: { src: 'classic 12-1 momentum', f: P => P.close.map(row => row.map((_, t) => (t >= 252 ? row[t - 21] / row[t - 252] - 1 : nan))) },
  REV5: { src: 'classic 5-day reversal', f: P => P.close.map(row => row.map((c, t) => (t >= 5 ? -(c / row[t - 5] - 1) : nan))) },
  LOWVOL60: { src: 'classic low volatility', f: P => map1(tsStd(P.close.map(row => row.map((c, t) => (t >= 1 ? c / row[t - 1] - 1 : nan))), 60), v => -v) },
  RANDOM: { src: 'control: random numbers', f: P => { let a = 20260408; const r = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; return P.close.map(row => row.map(() => r())); } }
};

module.exports = { csRank, tsCorr, tsStd, delta, spearman, FACTORS };
