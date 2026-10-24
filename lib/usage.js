// Outbound-bandwidth guard. Render's Hobby workspace suspends EVERYTHING when its 5 GB of monthly outbound traffic is used up (it happened on 23 Oct 2026).
// This module counts what this app sends out (responses to browsers, and the bodies of requests it makes to Redis, Yahoo, Gemini and Fyers) and protects the cap:
//   normal   below 60% of the budget : everything as usual
//   slow     60% to 85%              : the dashboard is told to refresh every 60 s and each visitor may fetch a heavy page at most every 30 s
//   protect  85% and above           : browser-facing pages and APIs answer with a tiny "budget reached" message; /health, /api/usage, the Fyers login and the trading engines keep working
// The budget defaults to 4 GB (BW_BUDGET_GB), leaving about 1 GB of the 5 GB for headers, TLS overhead and other services in the same workspace. The month rolls over on the 1st (UTC).
// A per-visitor minimum interval (3 s) on /api/state also blunts stale browser tabs still running an old 1.5-second polling script.
const GB = 1024 ** 3;

const monthOf = ms => new Date(ms).toISOString().slice(0, 7);

class BandwidthMeter {
  constructor({ budgetGb = 4, now = Date.now, slowAt = 0.6, protectAt = 0.85 } = {}) {
    this.budget = budgetGb * GB; this.now = now; this.slowAt = slowAt; this.protectAt = protectAt;
    this.month = monthOf(now()); this.bytes = 0; this.dirty = 0; this.lastSaved = 0;
  }
  roll() { const m = monthOf(this.now()); if (m !== this.month) { this.month = m; this.bytes = 0; this.dirty = 0; } }
  add(n) { if (!(n > 0)) return; this.roll(); this.bytes += n; this.dirty += n; }
  fraction() { this.roll(); return this.bytes / this.budget; }
  mode() { const f = this.fraction(); return f >= this.protectAt ? 'protect' : f >= this.slowAt ? 'slow' : 'normal'; }
  pollMs() { const m = this.mode(); return m === 'normal' ? 10000 : 60000; }
  snapshot() { this.roll(); return { month: this.month, bytes: this.bytes, gb: +(this.bytes / GB).toFixed(4), budgetGb: +(this.budget / GB).toFixed(3), fraction: +this.fraction().toFixed(4), mode: this.mode() }; }
  async load(store) {
    try { const j = await store.get('bw'); if (j && j.month === this.month) { this.bytes = Math.max(this.bytes, j.bytes || 0); } } catch (e) { /* start from zero: the guard errs towards counting less, so the budget leaves headroom for this */ }
  }
  async save(store, force = false) {
    if (!store || (!force && this.dirty < 1024 * 1024)) return;      // write only after another MB: the counter itself must not cost bandwidth
    try { await store.set('bw', { month: this.month, bytes: this.bytes, at: new Date(this.now()).toISOString() }); this.dirty = 0; } catch (e) { /* try again next time */ }
  }
}

// Count the bytes written to a response (after any compression).
function meterResponse(meter, res) {
  const w = res.write.bind(res), e = res.end.bind(res);
  res.write = (chunk, ...a) => { if (chunk) meter.add(Buffer.byteLength(chunk)); return w(chunk, ...a); };
  res.end = (chunk, ...a) => { if (chunk && typeof chunk !== 'function') meter.add(Buffer.byteLength(chunk)); meter.add(300); return e(chunk, ...a); };   // 300 B for the response headers
}

// Count the request bodies this app uploads to other services (Redis writes are the big ones). Responses it downloads are inbound and not counted.
function meterFetch(meter) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    let n = 400;
    try { const b = init && init.body; if (b) n += typeof b === 'string' ? Buffer.byteLength(b) : (b.byteLength || b.size || 0); } catch (e) { /* ignore */ }
    meter.add(n);
    return orig(input, init);
  };
  return () => { globalThis.fetch = orig; };
}

// Decide what to do with a browser-facing request. Returns null to proceed, or { code, body } to answer instead.
const ALWAYS = p => p === '/health' || p === '/api/usage' || p.startsWith('/fyers/') || p === '/api/fyers/status' || p === '/api/fyers/refresh' || p === '/api/control';
const HEAVY = p => p === '/api/state' || p === '/' || p === '/index.html' || p === '/settings' || (p.startsWith('/api/') && !ALWAYS(p));
class Gate {
  constructor(meter, { minState = 3000, minSlow = 30000 } = {}) { this.m = meter; this.minState = minState; this.minSlow = minSlow; this.seen = new Map(); }
  check(pathname, ip, method = 'GET') {
    if (method === 'POST' || ALWAYS(pathname) || !HEAVY(pathname)) return null;
    const mode = this.m.mode();
    if (mode === 'protect') return { code: 503, retryAfter: 3600, body: { error: 'bandwidth_budget', message: 'The monthly outbound-bandwidth budget is used up, so the dashboard is paused. Trading and saving continue. It resumes on the 1st of next month, or raise BW_BUDGET_GB.', usage: this.m.snapshot() } };
    const key = ip + '|' + (pathname === '/api/state' ? 's' : pathname), last = this.seen.get(key) || 0, t = this.m.now();
    const min = mode === 'slow' ? this.minSlow : pathname === '/api/state' ? this.minState : 0;
    if (min && t - last < min) return { code: 429, retryAfter: Math.ceil((min - (t - last)) / 1000), body: { error: 'too_frequent', message: 'Refreshing too often; the dashboard slows down as the monthly bandwidth budget is used.', usage: this.m.snapshot() } };
    this.seen.set(key, t);
    if (this.seen.size > 2000) for (const k of [...this.seen.keys()].slice(0, 1000)) this.seen.delete(k);
    return null;
  }
}

module.exports = { BandwidthMeter, meterResponse, meterFetch, Gate, GB };
