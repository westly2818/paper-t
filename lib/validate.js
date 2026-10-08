// Statistical checks for a list of trades: is the result better than chance?
// Ported in spirit from Vibe-Trading's backtest/validation.py, with one change that matters: their "permutation test"
// shuffles trade ORDER, which leaves the mean and spread of returns untouched, so it cannot tell an edge from none
// (it only measures drawdown luck). The tests here ask the right question about edge, and respect that trades on the
// same day are not independent (days are resampled / flipped as whole blocks).
//   cluster bootstrap   - confidence interval for average R and profit factor
//   sign-flip test      - is the average really above zero? (null: gains and losses are symmetric around zero)
//   walk-forward        - the result in consecutive time slices and how many are positive
//   drawdown shuffle    - was the worst drawdown typical or unlucky for these same trades
//   multiple testing    - adjusts a p-value for the number of variants tried

function rng(seed = 42) {            // mulberry32, deterministic
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const sum = a => a.reduce((x, y) => x + y, 0);
const mean = a => (a.length ? sum(a) / a.length : NaN);
const sd = a => { const m = mean(a); return a.length > 1 ? Math.sqrt(sum(a.map(v => (v - m) ** 2)) / (a.length - 1)) : NaN; };
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))];

function groupBy(values, keys) {     // [{key, vals:[...]}] in first-seen order
  const m = new Map();
  values.forEach((v, i) => { const k = keys ? keys[i] : i; if (!m.has(k)) m.set(k, []); m.get(k).push(v); });
  return [...m].map(([key, vals]) => ({ key, vals }));
}

function profitFactor(vals) {
  const gw = sum(vals.filter(v => v > 0)), gl = -sum(vals.filter(v => v <= 0));
  return gl > 0 ? gw / gl : Infinity;
}

// Resample whole clusters (days) with replacement; statistic computed on the pooled trades of each resample.
function clusterBootstrap(values, keys, { n = 5000, seed = 42, confidence = 0.95 } = {}) {
  const groups = groupBy(values, keys), G = groups.length, r = rng(seed);
  const means = [], pfs = [];
  for (let b = 0; b < n; b++) {
    const pooled = [];
    for (let g = 0; g < G; g++) pooled.push(...groups[Math.floor(r() * G)].vals);
    means.push(mean(pooled)); pfs.push(profitFactor(pooled));
  }
  means.sort((a, b) => a - b); pfs.sort((a, b) => a - b);
  const lo = (1 - confidence) / 2, hi = 1 - lo;
  return {
    clusters: G, mean: mean(values), meanLo: pct(means, lo), meanHi: pct(means, hi),
    probMeanAboveZero: means.filter(m => m > 0).length / n,
    pf: profitFactor(values), pfLo: pct(pfs, lo), pfHi: pct(pfs, hi)
  };
}

// Block sign-flip test. Null: each day's result is equally likely to be positive or negative around zero.
// p = share of random sign assignments whose average is at least as high as the observed one (one-sided: edge above 0).
function signFlipTest(values, keys, { n = 20000, seed = 7 } = {}) {
  const groups = groupBy(values, keys), sums = groups.map(g => sum(g.vals)), N = values.length;
  const observed = sum(sums) / N, r = rng(seed);
  let ge = 0;
  for (let b = 0; b < n; b++) {
    let s = 0;
    for (let g = 0; g < sums.length; g++) s += r() < 0.5 ? sums[g] : -sums[g];
    if (s / N >= observed - 1e-12) ge++;
  }
  return { observed, p: (ge + 1) / (n + 1), clusters: groups.length };
}

function binomialUpperTail(k, m) {    // P(X >= k) for X ~ Binomial(m, 0.5)
  let p = 0; for (let x = k; x <= m; x++) { let c = 1; for (let i = 1; i <= x; i++) c = c * (m - x + i) / i; p += c / 2 ** m; }
  return p;
}
function walkForward(values, windows = 4) {
  const n = values.length, out = [];
  for (let w = 0; w < windows; w++) {
    const a = Math.floor(w * n / windows), b = Math.floor((w + 1) * n / windows), part = values.slice(a, b);
    if (part.length) out.push({ window: w + 1, n: part.length, mean: mean(part), pf: profitFactor(part) });
  }
  const positive = out.filter(x => x.mean > 0).length;
  return { windows: out, positive, total: out.length, pAllThisGood: binomialUpperTail(positive, out.length) };
}

function maxDrawdown(vals) { let c = 0, peak = 0, dd = 0; for (const v of vals) { c += v; peak = Math.max(peak, c); dd = Math.max(dd, peak - c); } return dd; }
function drawdownShuffle(values, { n = 3000, seed = 11 } = {}) {
  const r = rng(seed), obs = maxDrawdown(values), dds = [];
  const a = values.slice();
  for (let b = 0; b < n; b++) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    dds.push(maxDrawdown(a));
  }
  dds.sort((x, y) => x - y);
  return { observed: obs, median: pct(dds, 0.5), p95: pct(dds, 0.95), shareAsBad: dds.filter(d => d >= obs).length / n };
}

const sidak = (p, tests) => 1 - Math.pow(1 - Math.min(1, p), Math.max(1, tests));

module.exports = { rng, mean, sd, profitFactor, clusterBootstrap, signFlipTest, walkForward, drawdownShuffle, maxDrawdown, sidak, groupBy };
