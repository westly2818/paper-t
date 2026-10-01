const http = require('http');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { YahooProvider, DemoProvider, Clock } = require('./lib/data');
const { Engine } = require('./lib/engine');
const { toCsv } = require('./lib/stats');
const { atMinute, dayKey, OPEN, CLOSE } = require('./lib/time');

const clock = new Clock(cfg.mode, cfg.speed);
const provider = cfg.mode === 'demo' ? new DemoProvider(clock, cfg) : new YahooProvider(clock, cfg);
const engine = new Engine(cfg, provider, clock);

async function startSession() {
  engine.reset();
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

const send = (res, code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/state') return send(res, 200, 'application/json', JSON.stringify(engine.snapshot()));
  if (url.pathname === '/api/journal.csv') { res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="journal.csv"' }); return res.end(toCsv(engine.S.closed)); }
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
        if (action === 'skip-news') engine.skipNews();
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
}).listen(cfg.port, () => {
  console.log(`Paper Trader (${cfg.mode} mode, capital ${cfg.capital}) running at http://localhost:${cfg.port}`);
  console.log(cfg.newsGuard ? 'News guard: ON (manual, paste from ChatGPT on the dashboard)' : 'News guard: OFF (live mode only by default, set NEWS_GUARD=1 to force it on)');
});
