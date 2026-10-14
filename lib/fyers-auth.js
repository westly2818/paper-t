// Fyers login from the web app: a button sends you to Fyers, you enter your PIN there, Fyers sends you back to /fyers/callback,
// and the server swaps the one-time code for an access token and saves it where the F&O and ISS books read it
// (the same key the local fyers-login.js writes: paper-trader:fyers:token).
// Also keeps the refresh token Fyers returns (valid about 15 days): with it, "Refresh with PIN" gets a new access token without the browser step.
// The PIN is only ever sent to Fyers: it is never stored or logged, except when you choose to set FYERS_PIN on the server for an automatic daily refresh.
// Needs FYERS_APP_ID and FYERS_SECRET in the server's environment, and the redirect URL below registered in your Fyers app.
const crypto = require('crypto');
const { Store } = require('./store');
const { dayKey } = require('./time');

const BASE = 'https://api-t1.fyers.in/api/v3';
const sha = (a, s) => crypto.createHash('sha256').update(`${a}:${s}`).digest('hex');
const DAY = 86400000;

class FyersAuth {
  constructor(cfg, opts = {}) {
    this.cfg = cfg; this.store = opts.store || new Store(cfg, 'fyers'); this.fetch = opts.fetch || fetch;
    this.env = opts.env || process.env; this.states = new Map(); this.refreshTries = []; this.lastAuto = 0;
  }
  appId() { return this.env.FYERS_APP_ID || null; }
  secret() { return this.env.FYERS_SECRET || null; }
  configured() { return !!(this.appId() && this.secret()); }
  // The redirect URL must match the one saved in the Fyers app EXACTLY. FYERS_REDIRECT wins; otherwise it is built from the address you opened the app at.
  redirectFor(req) {
    if (this.env.FYERS_REDIRECT) return this.env.FYERS_REDIRECT;
    const host = (req && req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || 'localhost:3000';
    const proto = (req && req.headers && req.headers['x-forwarded-proto']) || (/^(localhost|127\.)/.test(host) ? 'http' : 'https');
    return `${String(proto).split(',')[0]}://${host}/fyers/callback`;
  }
  startLogin(redirect, now = Date.now()) {
    for (const [k, t] of this.states) if (now - t > 10 * 60000) this.states.delete(k);
    const state = crypto.randomBytes(12).toString('hex'); this.states.set(state, now);
    const url = `${BASE}/generate-authcode?` + new URLSearchParams({ client_id: this.appId(), redirect_uri: redirect, response_type: 'code', state });
    return { url, state };
  }
  async post(path, body) {
    const r = await this.fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    return r.json().catch(() => ({}));
  }
  async save(j, now, keepRefresh) {
    const old = (await this.store.get('token')) || {};
    const rec = { appId: this.appId(), access_token: j.access_token, refresh_token: j.refresh_token || keepRefresh || old.refresh_token || null, savedAt: new Date(now).toISOString(), refreshTokenAt: j.refresh_token ? new Date(now).toISOString() : (old.refreshTokenAt || null) };
    await this.store.set('token', rec); return rec;
  }
  // Fyers sends the browser back with ?auth_code=...&state=...
  async handleCallback(query, now = Date.now()) {
    const state = query.state, code = query.auth_code || query.code;
    if (!state || !this.states.has(state) || now - this.states.get(state) > 10 * 60000) return { ok: false, status: 400, message: 'This login link expired or was not started from the app. Press "Log in to Fyers" again.' };
    this.states.delete(state);
    if (query.s === 'error' || !code) return { ok: false, status: 400, message: 'Fyers did not return a login code (login cancelled or failed).' };
    const j = await this.post('/validate-authcode', { grant_type: 'authorization_code', appIdHash: sha(this.appId(), this.secret()), code });
    if (!j.access_token) return { ok: false, status: 502, message: 'Fyers refused the code: ' + String(j.message || JSON.stringify(j)).slice(0, 160) };
    await this.save(j, now); return { ok: true, message: 'Fyers connected. The option books can read prices now.' };
  }
  // New access token from the refresh token and your PIN (no browser needed). Limited to 3 tries per 30 minutes so a wrong PIN cannot be hammered.
  async refreshWithPin(pin, now = Date.now()) {
    this.refreshTries = this.refreshTries.filter(t => now - t < 30 * 60000);
    if (this.refreshTries.length >= 3) return { ok: false, status: 429, message: 'Too many tries. Wait 30 minutes, or use the full Fyers login.' };
    const tok = await this.store.get('token');
    if (!tok || !tok.refresh_token) return { ok: false, status: 400, message: 'No refresh token saved yet. Use "Log in to Fyers" once.' };
    if (!/^\d{4}$/.test(String(pin || ''))) return { ok: false, status: 400, message: 'Enter your 4-digit Fyers PIN.' };
    this.refreshTries.push(now);
    const j = await this.post('/validate-refresh-token', { grant_type: 'refresh_token', appIdHash: sha(this.appId(), this.secret()), refresh_token: tok.refresh_token, pin: String(pin) });
    if (!j.access_token) return { ok: false, status: 502, message: 'Fyers refused the refresh: ' + String(j.message || 'unknown error').slice(0, 160) + '. If the refresh token has expired (about 15 days), use the full Fyers login.' };
    await this.save(j, now, tok.refresh_token); return { ok: true, message: 'Fyers token refreshed.' };
  }
  // What the page shows.
  async status(now = Date.now()) {
    const tok = await this.store.get('token');
    const s = { configured: this.configured(), connected: false, savedAt: null, hasRefresh: false, refreshDaysLeft: null, autoRefresh: !!this.env.FYERS_PIN };
    if (!tok) return s;
    const savedMs = Date.parse(tok.savedAt || 0) || 0;
    s.savedAt = savedMs || null; s.connected = !!tok.access_token && dayKey(savedMs) === dayKey(now);      // a token lasts to about midnight / early morning
    s.hasRefresh = !!tok.refresh_token;
    if (tok.refresh_token) { const at = Date.parse(tok.refreshTokenAt || tok.savedAt || 0) || 0; s.refreshDaysLeft = Math.max(0, 15 - Math.floor((now - at) / DAY)); }
    return s;
  }
  // Optional: with FYERS_PIN set on the server, refresh by itself each morning (08:30 to 09:10 IST) if today's token is missing.
  async maybeAutoRefresh(now = Date.now()) {
    const pin = this.env.FYERS_PIN; if (!pin || !this.configured() || now - this.lastAuto < 5 * 60000) return null;
    const m = new Date(now + 5.5 * 3600e3), mod = m.getUTCHours() * 60 + m.getUTCMinutes(), wd = m.getUTCDay();
    if (wd === 0 || wd === 6 || mod < 8 * 60 + 30 || mod > 9 * 60 + 10) return null;
    const s = await this.status(now); if (s.connected || !s.hasRefresh) return null;
    this.lastAuto = now; return this.refreshWithPin(pin, now);
  }
}

module.exports = { FyersAuth, sha };
