// Black-Scholes for European index options (Nifty): price and implied volatility. T in years, r the risk-free rate, no dividend.
const erf = x => { const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)); };
const N = x => 0.5 * (1 + erf(x / Math.SQRT2));
function price(type, S, K, T, sigma, r = 0.065) {
  if (T <= 0) return Math.max(0, type === 'CE' ? S - K : K - S);
  const v = sigma * Math.sqrt(T), d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / v, d2 = d1 - v;
  return type === 'CE' ? S * N(d1) - K * Math.exp(-r * T) * N(d2) : K * Math.exp(-r * T) * N(-d2) - S * N(-d1);
}
function impliedVol(type, S, K, T, px, r = 0.065) {
  let lo = 0.01, hi = 3;
  if (px <= price(type, S, K, T, lo, r) || px >= price(type, S, K, T, hi, r)) return NaN;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (price(type, S, K, T, mid, r) < px) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
module.exports = { price, impliedVol, N };
