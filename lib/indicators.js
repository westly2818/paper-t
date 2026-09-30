const { minOfDay, OPEN } = require('./time');

const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
function ema(vals, n) {
  const k = 2 / (n + 1);
  let e = vals[0];
  for (let i = 1; i < vals.length; i++) e = vals[i] * k + e * (1 - k);
  return e;
}
function rsi(closes, n = 14) {
  if (closes.length <= n) return 50;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (n - 1) + (d > 0 ? d : 0)) / n;
    l = (l * (n - 1) + (d < 0 ? -d : 0)) / n;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function atr(c, n = 14) {
  if (c.length <= n) return NaN;
  const tr = [];
  for (let i = 1; i < c.length; i++) tr.push(Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)));
  let a = avg(tr.slice(0, n));
  for (let i = n; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n;
  return a;
}
// Volume-weighted average price. Indexes have no volume, so fall back to the mean typical price.
function vwap(cs) {
  if (!cs.length) return NaN;
  let pv = 0, v = 0, sum = 0;
  for (const c of cs) { const tp = (c.h + c.l + c.c) / 3; pv += tp * c.v; v += c.v; sum += tp; }
  return v > 0 ? pv / v : sum / cs.length;
}
// Turn 1-minute candles into N-minute candles aligned to the 9:15 open.
function aggregate(c1, minutes = 5) {
  const out = [];
  let cur = null;
  for (const c of c1) {
    const b = Math.floor((minOfDay(c.t) - OPEN) / minutes);
    if (!cur || cur.b !== b) {
      cur = { b, t: c.t - ((minOfDay(c.t) - OPEN) % minutes) * 60000, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v };
      out.push(cur);
    } else { cur.h = Math.max(cur.h, c.h); cur.l = Math.min(cur.l, c.l); cur.c = c.c; cur.v += c.v; }
  }
  return out;
}
module.exports = { avg, ema, rsi, atr, vwap, aggregate };
