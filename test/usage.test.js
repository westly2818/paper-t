const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { BandwidthMeter, Gate, meterResponse, meterFetch, GB } = require('../lib/usage');

const clock = t => ({ now: () => t.v });

test('modes follow the share of the budget used: normal below 60%, slow to 85%, protect above', () => {
  const t = { v: Date.parse('2026-10-10T00:00:00Z') }, m = new BandwidthMeter({ budgetGb: 4, now: clock(t).now });
  assert.strictEqual(m.mode(), 'normal'); assert.strictEqual(m.pollMs(), 10000);
  m.add(2.3 * GB); assert.strictEqual(m.mode(), 'normal');
  m.add(0.2 * GB); assert.strictEqual(m.mode(), 'slow'); assert.strictEqual(m.pollMs(), 60000);
  m.add(0.9 * GB); assert.strictEqual(m.mode(), 'protect');
  assert.deepStrictEqual([m.snapshot().budgetGb, m.snapshot().mode], [4, 'protect']);
});

test('the counter starts again each month and survives a restart through the store', async () => {
  const t = { v: Date.parse('2026-10-31T23:00:00Z') }, kv = {};
  const store = { get: async k => kv[k] || null, set: async (k, v) => { kv[k] = JSON.parse(JSON.stringify(v)); } };
  const m = new BandwidthMeter({ budgetGb: 4, now: clock(t).now });
  m.add(3 * GB); await m.save(store);
  const again = new BandwidthMeter({ budgetGb: 4, now: clock(t).now }); await again.load(store);
  assert.strictEqual(again.mode(), 'slow', 'restored: 75% of the budget');
  t.v = Date.parse('2026-11-01T00:30:00Z'); assert.strictEqual(m.snapshot().bytes, 0); assert.strictEqual(m.snapshot().month, '2026-11'); assert.strictEqual(m.mode(), 'normal');
  const later = new BandwidthMeter({ budgetGb: 4, now: clock(t).now }); await later.load(store); assert.strictEqual(later.snapshot().bytes, 0, 'last month\'s count is not carried over');
  const small = new BandwidthMeter({ budgetGb: 4, now: clock(t).now }); small.add(1000); await small.save(store); assert.strictEqual(small.dirty, 1000, 'tiny changes are not written (the counter must not cost bandwidth)');
});

test('the gate: a stale tab polling every 1.5 s is cut, slow mode allows one heavy fetch per 30 s, protect mode blocks pages but never /health or the Fyers login', () => {
  const t = { v: Date.parse('2026-10-10T05:00:00Z') }, m = new BandwidthMeter({ budgetGb: 4, now: clock(t).now }), g = new Gate(m);
  assert.strictEqual(g.check('/api/state', '1.1.1.1'), null);
  t.v += 1500; assert.strictEqual(g.check('/api/state', '1.1.1.1').code, 429, 'second request after 1.5 s');
  assert.strictEqual(g.check('/api/state', '2.2.2.2'), null, 'another visitor is unaffected');
  t.v += 4000; assert.strictEqual(g.check('/api/state', '1.1.1.1'), null, '5.5 s later is fine in normal mode');
  m.add(2.6 * GB); t.v += 5000; assert.strictEqual(g.check('/api/state', '1.1.1.1').code, 429, 'slow mode: 5 s is too soon');
  t.v += 30000; assert.strictEqual(g.check('/api/state', '1.1.1.1'), null);
  m.add(1 * GB);
  for (const p of ['/', '/api/state', '/api/v5', '/api/iss', '/api/mlshadow', '/api/dbhealth', '/settings']) assert.strictEqual(g.check(p, '3.3.3.3').code, 503, p);
  for (const p of ['/health', '/api/usage', '/fyers/login', '/fyers/callback', '/api/fyers/status']) assert.strictEqual(g.check(p, '3.3.3.3'), null, p);
  assert.strictEqual(g.check('/api/control', '3.3.3.3', 'POST'), null, 'actions are never blocked');
  assert.ok(g.check('/api/state', '3.3.3.3').body.usage.mode === 'protect');
});

test('metering counts response bytes and uploaded request bodies', async () => {
  const m = new BandwidthMeter({ budgetGb: 4 });
  const sent = []; const res = { write: c => { sent.push(c); return true; }, end: c => { if (c) sent.push(c); } };
  meterResponse(m, res); res.write('abc'); res.end('defgh');
  assert.strictEqual(m.bytes, 3 + 5 + 300);
  const before = globalThis.fetch; let seen = null; globalThis.fetch = async (u, i) => { seen = i; return { ok: true }; };
  const restore = meterFetch(m); const b0 = m.bytes;
  await fetch('http://x', { method: 'POST', body: 'x'.repeat(1000) });
  assert.strictEqual(m.bytes - b0, 1400); assert.strictEqual(seen.body.length, 1000);
  restore(); globalThis.fetch = before;
});

test('server: usage is reported, /health stays open, and a tiny budget pauses the dashboard but not the health check', async () => {
  const port = 3993;
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(port), MODE: 'replay', BW_BUDGET_GB: '0.0000005', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '', DASH_PASSWORD: '' }, stdio: 'ignore' });
  const get = (p, h = {}) => new Promise((res, rej) => { const r = http.get({ port, path: p, headers: h }, x => { const c = []; x.on('data', d => c.push(d)); x.on('end', () => res({ status: x.statusCode, headers: x.headers, body: Buffer.concat(c).toString() })); }); r.on('error', rej); });
  try {
    let h; for (let i = 0; i < 40; i++) { try { h = await get('/health'); break; } catch (e) { await new Promise(r => setTimeout(r, 250)); } }
    assert.ok(h && h.status === 200 && h.body === 'ok');
    const u = JSON.parse((await get('/api/usage')).body); assert.ok(u.bytes > 0 && u.budgetGb < 0.00001);
    const page = await get('/'); assert.strictEqual(page.status, 503); assert.match(page.body, /Dashboard paused/);
    const st = await get('/api/state'); assert.strictEqual(st.status, 503); assert.strictEqual(JSON.parse(st.body).error, 'bandwidth_budget'); assert.ok(+st.headers['retry-after'] > 0);
    assert.strictEqual((await get('/health')).status, 200);
  } finally { srv.kill(); }
});
