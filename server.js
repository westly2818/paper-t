const http = require('http');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { YahooProvider, DemoProvider, Clock } = require('./lib/data');
const { Engine } = require('./lib/engine');
const { toCsv, recordsToCsv } = require('./lib/stats');
const { MomentumBook } = require('./lib/momentum');
const { MoverScanner } = require('./lib/movers');
const { V5Engine } = require('./lib/v5-engine');
const { FnoBook } = require('./lib/fno');
const { IssBook } = require('./lib/iss');
const { MlShadowView } = require('./lib/mlshadow');
const { FyersAuth } = require('./lib/fyers-auth');
const { atMinute, dayKey, OPEN, CLOSE } = require('./lib/time');
const dbhealth = require('./lib/dbhealth');

const clock = new Clock(cfg.mode, cfg.speed);
const provider = cfg.mode === 'demo' ? new DemoProvider(clock, cfg) : new YahooProvider(clock, cfg);
const engine = new Engine(cfg, provider, clock);

async function startSession() {
  engine.reset();
  await engine.loadSettings();
  if (cfg.mode === 'live') await engine.load();
  else {
    const day = await provider.pickReplayDay();
    cfg.replayDay = cfg.replayDay || day;
    clock.start(atMinute(day, 9 * 60 + 5), atMinute(day, CLOSE + 2));
    console.log(`${cfg.mode.toUpperCase()} session on ${day} (speed ${clock.speed}x)`);
  }
}

let starting = null;
const ready = () => (starting = starting || startSession().catch(e => { engine.S.error = e.message; console.error(e.message); starting = null; }));

setInterval(async () => {
  await ready();
  if (starting) await engine.poll();
}, cfg.mode === 'live' ? 20000 : 1000);

// Momentum book: separate paper portfolio on its own timer and storage keys. Errors stay inside it.
const mbook = cfg.mbookEnabled ? new MomentumBook(cfg) : null;
if (mbook) {
  mbook.load().then(() => setInterval(() => { mbook.tick().catch(e => console.error('Momentum book:', e.message)); }, 60000))
    .catch(e => console.error('Momentum book failed to start:', e.message));
}

// Mover scanner: a study (never trades), own timer and storage keys. Errors stay inside it.
const movers = cfg.moversEnabled ? new MoverScanner(cfg) : null;
if (movers) {
  movers.load().then(() => setInterval(() => { movers.tick().catch(e => console.error('Movers:', e.message)); }, 60000))
    .catch(e => console.error('Mover scanner failed to start:', e.message));
}

// Momentum Strategy V5: separate paper engine on its own timer and storage keys.
const v5 = cfg.v5Enabled ? new V5Engine(cfg) : null;
if (v5) {
  v5.load().then(() => setInterval(() => { v5.tick().catch(e => console.error('V5 Engine:', e.message)); }, cfg.mode === 'live' ? 20000 : 5000))
    .catch(e => console.error('V5 Engine failed to start:', e.message));
}

// F&O paper book (weekly NIFTY iron condor + option chain log): own timer and storage keys.
const fno = cfg.fnoEnabled ? new FnoBook(cfg) : null;
if (fno) {
  fno.load().then(() => setInterval(() => { fno.tick().catch(e => console.error('F&O book:', e.message)); }, 60000))
    .catch(e => console.error('F&O book failed to start:', e.message));
}

// ISS paper book (intraday short straddle on real option quotes): own timer and storage keys.
const iss = cfg.issEnabled ? new IssBook(cfg) : null;
const mlShadow = new MlShadowView(cfg);           // read-only view of the ML shadow predictions (separate service)
if (iss) {
  iss.load().then(() => setInterval(() => { iss.tick().catch(e => console.error('ISS book:', e.message)); }, 60000))
    .catch(e => console.error('ISS book failed to start:', e.message));
}

// Fyers login from the page (button, PIN refresh). Needs FYERS_APP_ID and FYERS_SECRET in the environment.
const fyersAuth = cfg.mode === 'live' || process.env.FYERS_FORCE === '1' ? new FyersAuth(cfg) : null;
if (fyersAuth) setInterval(() => { fyersAuth.maybeAutoRefresh().then(r => { if (r) console.log('Fyers auto refresh:', r.ok ? 'ok' : r.message); }).catch(e => console.error('Fyers auto refresh:', e.message)); }, 5 * 60000);

// Render sends SIGTERM on every redeploy or restart: write everything out before exiting.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    try { if (iss && iss.state) await iss.save(); } catch (e) { console.error('ISS shutdown save failed:', e.message); }
    try { if (fno && fno.state) await fno.save(); } catch (e) { console.error('F&O shutdown save failed:', e.message); }
    try { if (v5 && v5.state) await v5.save(); } catch (e) { console.error('V5 shutdown save failed:', e.message); }
    try { if (movers && movers.state) await movers.save(); } catch (e) { console.error('Movers shutdown save failed:', e.message); }
    try { if (mbook && mbook.state) await mbook.save(); } catch (e) { console.error('Momentum book shutdown save failed:', e.message); }
    try { await engine.flush(); await engine.save(); } catch (e) { console.error('Shutdown save failed:', e.message); }
    process.exit(0);
  });
}

const fyersPage = (title, text, ok) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px"><h2 style="color:${ok ? '#0B8A5B' : '#D0402D'}">${title}</h2><p>${String(text).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p><p><a href="/#data">Back to the app</a></p>${ok ? '<script>setTimeout(function(){location.href="/#data"},2500)</script>' : ''}</body>`;
// Render's free workspace allows 5 GB of outgoing traffic a month and suspends everything when it is used up. The dashboard page asks for the
// 250 KB state again and again, so text answers are gzip-compressed (about 5x smaller) when the browser accepts it.
const zlib = require('zlib');
const sha256 = x => require('crypto').createHash('sha256').update(x).digest();
const send = (res, code, type, body) => {
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' };
  if (res.acceptsGzip && /^(application\/json|text\/)/.test(type) && Buffer.byteLength(body) > 1024) { body = zlib.gzipSync(body); headers['Content-Encoding'] = 'gzip'; }
  res.writeHead(code, headers); res.end(body);
};

// Data tab: is everything being saved to the database? The Redis facts are cached for 15 minutes (a manual re-check is allowed once a
// minute) so the page can poll often; the "last saved" heartbeat is recomputed live on every request.
const dbh = { facts: null, at: 0, busy: null };
async function dbHealth(fresh) {
  const age = Date.now() - dbh.at;
  if (!dbh.facts && !dbh.busy || age > (fresh ? 60e3 : 15 * 60e3)) {
    if (!dbh.busy) dbh.busy = dbhealth.collectFacts(engine).then(f => { dbh.facts = f; dbh.at = Date.now(); }).catch(e => { dbh.facts = { redis: { ok: false, error: e.message }, tradingDays: [], tradingDaysKnown: false, have: { dayRecord: new Set(), candles: new Set(), bars5m: new Set() }, logs: [], backup: null, collectedAt: Date.now() }; dbh.at = Date.now(); }).finally(() => { dbh.busy = null; });
    await dbh.busy;
  }
  return dbhealth.view(dbh.facts, engine);
}

const server = http.createServer((req, res) => {
  res.acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const url = new URL(req.url, 'http://x');
  // Optional password for the whole app (set DASH_PASSWORD, and DASH_USER if you do not want 'admin'). The uptime check /health stays open.
  if (process.env.DASH_PASSWORD && url.pathname !== '/health') {
    const want = [process.env.DASH_USER || 'admin', process.env.DASH_PASSWORD];
    const h = req.headers.authorization || '';
    const got = h.startsWith('Basic ') ? Buffer.from(h.slice(6), 'base64').toString().split(/:(.*)/s) : [];
    const same = (x, y) => require('crypto').timingSafeEqual(sha256(String(x)), sha256(String(y)));
    if (!(got.length >= 2 && same(got[0], want[0]) && same(got[1], want[1]))) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="paper-trader"', 'Content-Type': 'text/plain' }); return res.end('Login required'); }
  }
  if (url.pathname === '/api/dbhealth') return dbHealth(url.searchParams.get('fresh') === '1').then(d => send(res, 200, 'application/json', JSON.stringify(d))).catch(e => send(res, 500, 'application/json', JSON.stringify({ error: e.message })));
  if (url.pathname === '/health') return send(res, 200, 'text/plain', 'ok');   // tiny answer for uptime monitors (UptimeRobot): 2 bytes instead of the 90 KB page
  if (url.pathname === '/api/state') return send(res, 200, 'application/json', JSON.stringify(engine.snapshot()));
  if (url.pathname === '/api/journal.csv') { res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="journal.csv"' }); return res.end(toCsv(engine.S.closed)); }
  if (url.pathname.startsWith('/api/export/')) {
    const what = url.pathname.slice(12);
    (async () => {
      try {
        if (what === 'bars5m.json') {
          const b = await engine.readBlob('bars5m:' + (url.searchParams.get('day') || ''));
          return b ? send(res, 200, 'application/json', JSON.stringify(b)) : send(res, 404, 'application/json', '{"error":"no universe archive for that day"}');
        }
        if (what === 'candles.json') {
          const c = await engine.readCandles(url.searchParams.get('day') || '');
          return c ? send(res, 200, 'application/json', JSON.stringify(c)) : send(res, 404, 'application/json', '{"error":"no candles saved for that day"}');
        }
        const [name, ext] = what.split('.');
        if (!['trades', 'days', 'signals'].includes(name) || !['json', 'csv'].includes(ext)) return send(res, 404, 'text/plain', 'Not found');
        const list = await engine.readList(name);
        res.writeHead(200, { 'Content-Type': ext === 'csv' ? 'text/csv' : 'application/json', 'Content-Disposition': `attachment; filename="${name}.${ext}"`, 'Cache-Control': 'no-store' });
        res.end(ext === 'csv' ? recordsToCsv(list) : JSON.stringify(list));
      } catch (e) { send(res, 500, 'application/json', JSON.stringify({ error: e.message })); }
    })();
    return;
  }
  if (url.pathname === '/api/movers') return send(res, 200, 'application/json', JSON.stringify(movers ? movers.snapshot() : { enabled: false }));
  if (url.pathname === '/api/movers/scans.json' || url.pathname === '/api/movers/outcomes.json') {
    if (!movers) return send(res, 404, 'application/json', '{"error":"mover scanner is off"}');
    movers.store.list(url.pathname.includes('scans') ? 'scans' : 'outcomes').then(l => send(res, 200, 'application/json', JSON.stringify(l))).catch(e => send(res, 500, 'application/json', JSON.stringify({ error: e.message })));
    return;
  }
  if (url.pathname === '/api/mbook') return send(res, 200, 'application/json', JSON.stringify(mbook ? mbook.snapshot() : { enabled: false }));
  if (url.pathname === '/api/mbook/trades.json') {
    if (!mbook) return send(res, 404, 'application/json', '{"error":"momentum book is off"}');
    mbook.store.list('trades').then(l => send(res, 200, 'application/json', JSON.stringify(l))).catch(e => send(res, 500, 'application/json', JSON.stringify({ error: e.message })));
    return;
  }
  if (url.pathname === '/api/mlshadow') return mlShadow.snapshot().then(j => send(res, 200, 'application/json', JSON.stringify(j))).catch(e => send(res, 200, 'application/json', JSON.stringify({ enabled: true, readOnly: true, empty: true, note: 'Could not read the shadow records: ' + e.message })));
  if (url.pathname === '/api/iss') return send(res, 200, 'application/json', JSON.stringify(iss ? iss.snapshot() : { enabled: false }));
  if (url.pathname === '/api/iss/trades.json' || url.pathname === '/api/iss/quotes.json') { if (!iss) return send(res, 404, 'application/json', '{}'); return iss.store.list(url.pathname.includes('trades') ? 'trades' : 'quotes').then(l => send(res, 200, 'application/json', JSON.stringify(l))).catch(e => send(res, 500, 'application/json', JSON.stringify({ error: e.message }))); }
  // ---- Fyers login from the page
  if (url.pathname === '/api/fyers/status') { if (!fyersAuth) return send(res, 200, 'application/json', '{"enabled":false}'); return fyersAuth.status().then(st => send(res, 200, 'application/json', JSON.stringify({ enabled: true, ...st, redirect: fyersAuth.redirectFor(req) }))).catch(e => send(res, 500, 'application/json', JSON.stringify({ error: e.message }))); }
  if (url.pathname === '/fyers/login') {
    if (!fyersAuth || !fyersAuth.configured()) return send(res, 400, 'text/html; charset=utf-8', fyersPage('Fyers login is not set up', 'The server needs FYERS_APP_ID and FYERS_SECRET in its environment. Add them (Render: Environment tab), redeploy, and try again.', false));
    const { url: to } = fyersAuth.startLogin(fyersAuth.redirectFor(req)); res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' }); return res.end();
  }
  if (url.pathname === '/fyers/callback' || url.pathname === '/callback') {
    if (!fyersAuth) return send(res, 404, 'text/plain', 'Not found');
    const q = Object.fromEntries(url.searchParams);
    return fyersAuth.handleCallback(q).then(r => send(res, r.ok ? 200 : r.status || 400, 'text/html; charset=utf-8', fyersPage(r.ok ? 'Fyers connected' : 'Fyers login did not complete', r.message, r.ok))).catch(e => send(res, 500, 'text/html; charset=utf-8', fyersPage('Fyers login failed', e.message, false)));
  }
  if (url.pathname === '/api/fyers/refresh' && req.method === 'POST') {
    if (!fyersAuth) return send(res, 404, 'application/json', '{"ok":false,"message":"Fyers login is off"}');
    let body = ''; req.on('data', c => { body += c; if (body.length > 2000) req.destroy(); });
    req.on('end', () => { let pin = ''; try { pin = JSON.parse(body).pin; } catch (e) { /* bad body */ } fyersAuth.refreshWithPin(pin).then(r => send(res, r.ok ? 200 : r.status || 400, 'application/json', JSON.stringify({ ok: r.ok, message: r.message }))).catch(e => send(res, 500, 'application/json', JSON.stringify({ ok: false, message: e.message }))); });
    return;
  }
  if (url.pathname === '/api/fno') return send(res, 200, 'application/json', JSON.stringify(fno ? fno.snapshot() : { enabled: false }));
  if (url.pathname === '/api/fno/chain.json') { if (!fno) return send(res, 404, 'application/json', '{}'); return fno.store.list('chain').then(l => send(res, 200, 'application/json', JSON.stringify(l))).catch(e => send(res, 500, 'application/json', JSON.stringify({ error: e.message }))); }
  if (url.pathname === '/api/fno/trades.json') { if (!fno) return send(res, 404, 'application/json', '{}'); return fno.store.list('trades').then(l => send(res, 200, 'application/json', JSON.stringify(l))).catch(e => send(res, 500, 'application/json', JSON.stringify({ error: e.message }))); }
  if (url.pathname === '/api/v5') return send(res, 200, 'application/json', JSON.stringify(v5 ? v5.snapshot() : { enabled: false }));
  if (url.pathname === '/api/v5/trades.json') {
    if (!v5) return send(res, 404, 'application/json', '{"error":"v5 engine is off"}');
    v5.store.list('trades').then(l => send(res, 200, 'application/json', JSON.stringify(l))).catch(e => send(res, 500, 'application/json', JSON.stringify({ error: e.message })));
    return;
  }
  if (url.pathname === '/api/settings' && req.method === 'GET') return send(res, 200, 'application/json', JSON.stringify(engine.settingsView()));
  if (url.pathname === '/api/settings/log') {
    engine.readList('settings-log').then(list => send(res, 200, 'application/json', JSON.stringify(list.slice(-100).reverse())))
      .catch(e => send(res, 500, 'application/json', JSON.stringify({ error: e.message })));
    return;
  }
  if (url.pathname === '/api/settings' && req.method === 'POST') {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', async () => {
      try {
        const { changes } = JSON.parse(body || '{}');
        const r = await engine.saveSettings(changes);
        send(res, 200, 'application/json', JSON.stringify({ ok: true, ...r, ...engine.settingsView() }));
      } catch (e) { send(res, 400, 'application/json', JSON.stringify({ error: e.message, fields: e.fields || null })); }
    });
    return;
  }
  if (url.pathname === '/settings') return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(__dirname, 'public', 'settings.html')));
  if (url.pathname === '/api/control' && req.method === 'POST') {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', async () => {
      try {
        const { action, value } = JSON.parse(body || '{}');
        if (cfg.mode !== 'live') {
          if (action === 'pause') clock.pause();
          else if (action === 'resume') clock.resume();
          else if (action === 'speed' && [10, 60, 300, 1200].includes(+value)) clock.setSpeed(+value);
          else if (action === 'restart') { starting = null; await ready(); }
        }
        if (action === 'retry-news') engine.retryAutoNews();
        else if (action === 'skip-news') engine.skipNews();
        else if (action === 'skip-replacements') engine.skipReplacementsNews();
        send(res, 200, 'application/json', '{"ok":true}');
      } catch (e) { send(res, 400, 'application/json', JSON.stringify({ error: e.message })); }
    });
    return;
  }
  if (url.pathname === '/api/news' && req.method === 'POST') {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      try {
        const { text } = JSON.parse(body || '{}');
        engine.applyManualNews(text);
        send(res, 200, 'application/json', '{"ok":true}');
      } catch (e) { send(res, 400, 'application/json', JSON.stringify({ error: e.message })); }
    });
    return;
  }
  if (url.pathname === '/api/news/replacement' && req.method === 'POST') {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      try {
        const { text } = JSON.parse(body || '{}');
        engine.applyReplacementsNews(text);
        send(res, 200, 'application/json', '{"ok":true}');
      } catch (e) { send(res, 400, 'application/json', JSON.stringify({ error: e.message })); }
    });
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
  send(res, 404, 'text/plain', 'Not found');
});

// Saved settings are loaded before the first request is served, so a restart never runs on defaults.
engine.loadSettings().finally(() => server.listen(cfg.port, () => {
  console.log(`Paper Trader (${cfg.mode} mode, capital ${cfg.capital}) running at http://localhost:${cfg.port}`);
  console.log(cfg.newsGuard ? 'News guard: ON (manual, paste from ChatGPT on the dashboard)' : 'News guard: OFF (live mode only by default, set NEWS_GUARD=1 to force it on)');
}));
