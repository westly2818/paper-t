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

// Render sends SIGTERM on every redeploy or restart: write everything out before exiting.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    try { if (fno && fno.state) await fno.save(); } catch (e) { console.error('F&O shutdown save failed:', e.message); }
    try { if (v5 && v5.state) await v5.save(); } catch (e) { console.error('V5 shutdown save failed:', e.message); }
    try { if (movers && movers.state) await movers.save(); } catch (e) { console.error('Movers shutdown save failed:', e.message); }
    try { if (mbook && mbook.state) await mbook.save(); } catch (e) { console.error('Momentum book shutdown save failed:', e.message); }
    try { await engine.flush(); await engine.save(); } catch (e) { console.error('Shutdown save failed:', e.message); }
    process.exit(0);
  });
}

const send = (res, code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };

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
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/dbhealth') return dbHealth(url.searchParams.get('fresh') === '1').then(d => send(res, 200, 'application/json', JSON.stringify(d))).catch(e => send(res, 500, 'application/json', JSON.stringify({ error: e.message })));
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
