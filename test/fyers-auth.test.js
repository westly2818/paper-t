const test = require('node:test');
const assert = require('node:assert');
const { FyersAuth, sha } = require('../lib/fyers-auth');

const IST = 5.5 * 3600e3, at = (day, hhmm) => { const [h, m] = hhmm.split(':').map(Number); return Date.parse(day + 'T00:00:00Z') - IST + (h * 60 + m) * 60000; };
const memStore = () => { let v = null; return { get: async () => (v ? JSON.parse(JSON.stringify(v)) : null), set: async (k, x) => { v = JSON.parse(JSON.stringify(x)); }, peek: () => v }; };
function make(responses, env = { FYERS_APP_ID: 'APP-100', FYERS_SECRET: 'SECRET' }) {
  const calls = [], store = memStore();
  const fetchImpl = async (url, o) => { calls.push({ url, body: JSON.parse(o.body) }); const r = responses.shift(); return { json: async () => r }; };
  return { a: new FyersAuth({}, { store, fetch: fetchImpl, env }), calls, store };
}

test('login url carries the app id, the redirect and a fresh state', () => {
  const { a } = make([]);
  const { url, state } = a.startLogin('https://paper-t.onrender.com/fyers/callback');
  const u = new URL(url);
  assert.strictEqual(u.searchParams.get('client_id'), 'APP-100'); assert.strictEqual(u.searchParams.get('redirect_uri'), 'https://paper-t.onrender.com/fyers/callback');
  assert.strictEqual(u.searchParams.get('response_type'), 'code'); assert.strictEqual(u.searchParams.get('state'), state); assert.ok(state.length >= 16);
});

test('redirect: FYERS_REDIRECT wins, else built from the address the app was opened at', () => {
  const a = make([], { FYERS_APP_ID: 'A', FYERS_SECRET: 'S', FYERS_REDIRECT: 'http://127.0.0.1:3000/callback' }).a;
  assert.strictEqual(a.redirectFor({ headers: { host: 'x.com' } }), 'http://127.0.0.1:3000/callback');
  const b = make([]).a;
  assert.strictEqual(b.redirectFor({ headers: { host: 'paper-t.onrender.com', 'x-forwarded-proto': 'https' } }), 'https://paper-t.onrender.com/fyers/callback');
  assert.strictEqual(b.redirectFor({ headers: { host: 'localhost:3000' } }), 'http://localhost:3000/fyers/callback');
});

test('callback: a valid state and code are exchanged and the token (with refresh token) is saved', async () => {
  const { a, calls, store } = make([{ s: 'ok', access_token: 'ACC', refresh_token: 'REF' }]);
  const { state } = a.startLogin('r', at('2026-10-14', '08:50'));
  const res = await a.handleCallback({ auth_code: 'CODE', state }, at('2026-10-14', '08:52'));
  assert.strictEqual(res.ok, true);
  assert.strictEqual(calls[0].url, 'https://api-t1.fyers.in/api/v3/validate-authcode');
  assert.strictEqual(calls[0].body.appIdHash, sha('APP-100', 'SECRET')); assert.strictEqual(calls[0].body.code, 'CODE');
  const t = store.peek(); assert.strictEqual(t.access_token, 'ACC'); assert.strictEqual(t.refresh_token, 'REF'); assert.strictEqual(t.appId, 'APP-100');
});

test('callback: an unknown or expired state is refused and nothing is saved', async () => {
  const { a, calls, store } = make([{ access_token: 'X' }]);
  assert.strictEqual((await a.handleCallback({ auth_code: 'C', state: 'forged' })).ok, false);
  const { state } = a.startLogin('r', 1000);
  assert.strictEqual((await a.handleCallback({ auth_code: 'C', state }, 1000 + 11 * 60000)).ok, false);
  assert.strictEqual(calls.length, 0); assert.strictEqual(store.peek(), null);
});

test('callback: a state can be used only once, and Fyers errors are reported', async () => {
  const { a } = make([{ s: 'error', message: 'invalid code' }]);
  const { state } = a.startLogin('r');
  const bad = await a.handleCallback({ auth_code: 'C', state });
  assert.strictEqual(bad.ok, false); assert.match(bad.message, /invalid code/);
  assert.strictEqual((await a.handleCallback({ auth_code: 'C', state })).ok, false);
});

test('refresh with PIN: sends the refresh token and PIN, keeps the refresh token, never saves the PIN, rate limits wrong tries', async () => {
  const { a, calls, store } = make([{ access_token: 'NEW' }, { s: 'error', message: 'invalid pin' }, { s: 'error', message: 'invalid pin' }, { s: 'error', message: 'invalid pin' }]);
  await store.set('token', { appId: 'APP-100', access_token: 'OLD', refresh_token: 'REF', savedAt: new Date(at('2026-10-13', '09:00')).toISOString(), refreshTokenAt: new Date(at('2026-10-13', '09:00')).toISOString() });
  const t0 = at('2026-10-14', '08:40');
  const ok = await a.refreshWithPin('1234', t0);
  assert.strictEqual(ok.ok, true); assert.strictEqual(calls[0].url, 'https://api-t1.fyers.in/api/v3/validate-refresh-token');
  assert.strictEqual(calls[0].body.refresh_token, 'REF'); assert.strictEqual(calls[0].body.pin, '1234');
  assert.strictEqual(store.peek().access_token, 'NEW'); assert.strictEqual(store.peek().refresh_token, 'REF');
  assert.strictEqual(JSON.stringify(store.peek()).includes('1234'), false, 'the PIN is never saved');
  assert.strictEqual((await a.refreshWithPin('9999', t0 + 1000)).ok, false);
  assert.notStrictEqual((await a.refreshWithPin('9999', t0 + 2000)).status, 429);
  const blocked = await a.refreshWithPin('9999', t0 + 3000);
  assert.strictEqual(blocked.status, 429); assert.strictEqual(calls.length, 3, 'no call to Fyers once rate limited');
  assert.strictEqual((await a.refreshWithPin('abc', t0 + 31 * 60000)).ok, false);
});

test('status: connected only if saved today; refresh token days left', async () => {
  const { a, store } = make([]);
  assert.strictEqual((await a.status()).connected, false);
  await store.set('token', { access_token: 'T', refresh_token: 'R', savedAt: new Date(at('2026-10-14', '08:55')).toISOString(), refreshTokenAt: new Date(at('2026-10-10', '08:55')).toISOString() });
  const s = await a.status(at('2026-10-14', '12:00'));
  assert.strictEqual(s.connected, true); assert.strictEqual(s.hasRefresh, true); assert.strictEqual(s.refreshDaysLeft, 11);
  assert.strictEqual((await a.status(at('2026-10-15', '09:00'))).connected, false);
});

test('auto refresh: only with FYERS_PIN, only in the morning window, only if today has no token', async () => {
  const noPin = make([{ access_token: 'N' }]);
  assert.strictEqual(await noPin.a.maybeAutoRefresh(at('2026-10-14', '08:45')), null);
  const { a, calls, store } = make([{ access_token: 'N' }], { FYERS_APP_ID: 'APP-100', FYERS_SECRET: 'SECRET', FYERS_PIN: '1234' });
  await store.set('token', { access_token: 'OLD', refresh_token: 'R', savedAt: new Date(at('2026-10-13', '09:00')).toISOString() });
  assert.strictEqual(await a.maybeAutoRefresh(at('2026-10-14', '10:00')), null);       // too late in the day
  assert.strictEqual(await a.maybeAutoRefresh(at('2026-10-17', '08:45')), null);       // Saturday
  const r = await a.maybeAutoRefresh(at('2026-10-14', '08:45'));
  assert.strictEqual(r.ok, true); assert.strictEqual(calls.length, 1);
  assert.strictEqual(await a.maybeAutoRefresh(at('2026-10-14', '08:46')), null);       // already connected today
});
