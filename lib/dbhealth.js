// Database health for the Data tab: is the app really saving, is any trading day missing, is Redis filling up,
// and when was the last backup to the local MongoDB (db-sync.js leaves a marker key). Read-only on Redis.
//   assess(facts)   pure rules -> status, messages and the per-day table (tested)
//   collect(engine) gathers the facts with ONE batched Redis request, then calls assess
const IST = 5.5 * 3600e3;
const dayStr = ms => new Date(ms + IST).toISOString().slice(0, 10);
const minuteOfDay = ms => { const d = new Date(ms + IST); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const weekday = ms => { const w = new Date(ms + IST).getUTCDay(); return w >= 1 && w <= 5; };
const MIN = 60000, HOUR = 3600000, DAY = 86400000;
// The first day each kind of data has been kept. Earlier days are not flagged as missing (they were never saved).
const KEPT_SINCE = { dayRecord: '2026-10-01', candles: '2026-10-01', bars5m: '2026-10-05' };

function ago(ms, now) {
  if (ms == null) return 'never';
  const d = now - ms;
  if (d < 90 * 1000) return 'just now';
  if (d < HOUR) return Math.round(d / MIN) + ' min ago';
  if (d < DAY) return Math.round(d / HOUR) + ' h ago';
  return Math.round(d / DAY) + ' days ago';
}

// the trading day of a stored list item (same rule as db-sync.js)
function dayOf(rec) {
  if (!rec || typeof rec !== 'object') return null;
  if (typeof rec.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rec.day)) return rec.day;
  for (const k of ['t', 'at', 'decidedAt', 'closedAt', 'tOut', 'tIn']) if (Number.isFinite(rec[k]) && rec[k] > 1e12) return dayStr(rec[k]);
  return null;
}
function timeOf(rec) {
  if (!rec || typeof rec !== 'object') return null;
  for (const k of ['at', 't', 'closedAt', 'tOut', 'decidedAt', 'tIn']) if (Number.isFinite(rec[k]) && rec[k] > 1e12) return rec[k];
  return null;
}

/* facts = {
     now, uptimeMs,
     redis: { ok, error?, usedMb, maxMb },
     engine: { lastSaveAt, lastSaveError, lastSaveErrorAt, lastFlushAt, lastFlushError, lastFlushErrorAt, outbox },
     tradingDays: ['YYYY-MM-DD', ...] (ascending, the sessions that actually traded, today included once it has traded), tradingDaysKnown,
     have: { dayRecord: Set, candles: Set, bars5m: Set },
     logs: [{ id, label, items, lastDay, lastAt }],
     backup: { at, latestDay, listItemsAdded, blobsAdded, warnings } | null
   } */
function assess(f) {
  const now = f.now, today = dayStr(now), mod = minuteOfDay(now), msgs = [];
  const add = (level, code, text) => msgs.push({ level, code, text });
  const e = f.engine || {};

  // ---- 1. can we reach the database, and is it filling up
  if (!f.redis || !f.redis.ok) add('bad', 'redis-down', `Cannot reach the database${f.redis && f.redis.error ? ' (' + f.redis.error + ')' : ''}. Nothing new can be saved until it is back.`);
  else if (f.redis.maxMb) {
    const pct = f.redis.usedMb / f.redis.maxMb * 100;
    if (pct >= 90) add('bad', 'redis-full', `Database is ${pct.toFixed(0)}% full (${f.redis.usedMb.toFixed(1)} of ${f.redis.maxMb.toFixed(0)} MB). Back it up and clear old price archives now, or saving will fail.`);
    else if (pct >= 70) add('warn', 'redis-filling', `Database is ${pct.toFixed(0)}% full. Back it up and plan to clear old price archives.`);
  }

  // ---- 2. is the app saving right now
  const recentSaveError = e.lastSaveErrorAt && now - e.lastSaveErrorAt < 10 * MIN && (!e.lastSaveAt || e.lastSaveAt < e.lastSaveErrorAt);
  if (recentSaveError) add('bad', 'save-failed', `The last save of the bot state to the database failed: ${e.lastSaveError}`);
  const marketHours = weekday(now) && mod >= 9 * 60 && mod <= 16 * 60 && f.tradingToday !== false;
  if (marketHours && (f.uptimeMs == null || f.uptimeMs > 5 * MIN) && !recentSaveError) {
    const age = e.lastSaveAt ? now - e.lastSaveAt : Infinity;
    if (age > 15 * MIN) add('bad', 'not-saving', `The bot has not saved to the database for ${e.lastSaveAt ? Math.round(age / MIN) + ' minutes' : 'a long time'} during market hours. Check that the server is awake and running.`);
    else if (age > 5 * MIN) add('warn', 'save-slow', `Last save to the database was ${Math.round(age / MIN)} minutes ago (it normally saves every minute).`);
  }
  if (e.outbox > 0 && (!e.lastFlushAt || now - e.lastFlushAt > 10 * MIN)) add('warn', 'log-backlog', `${e.outbox} log records (trades, signals) are waiting to be written to the database${e.lastFlushError ? ': ' + e.lastFlushError : ''}.`);

  // ---- 3. is every trading day's data in the database
  const types = [['dayRecord', 'Day record'], ['candles', 'Day candles'], ['bars5m', '5-minute archive']];
  const first = { ...KEPT_SINCE, ...(f.keptSince || {}) };
  const rows = [];
  const missingDays = new Set();
  for (const d of f.tradingDays || []) {
    const row = { day: d };
    for (const [t, label] of types) {
      if (first[t] == null || d < first[t]) { row[t] = 'n/a'; continue; }      // before this kind of data was being kept
      if (f.have[t].has(d)) { row[t] = 'ok'; continue; }
      if (d === today && mod < 16 * 60 + 30) { row[t] = 'pending'; continue; }  // saved after the close, with a grace period
      row[t] = 'missing'; missingDays.add(d + '|' + label);
    }
    rows.push(row);
  }
  for (const key of missingDays) {
    const [d, label] = key.split('|');
    add(f.tradingDaysKnown === false ? 'warn' : 'bad', 'missing-' + d, `${label} for ${d} is missing from the database${d === today ? ' (it should have been saved after the close)' : ''}${f.tradingDaysKnown === false ? ' (could be a market holiday)' : ''}.`);
  }

  // ---- 4. backup to the local MongoDB
  if (!f.backup) add('warn', 'no-backup', 'No backup to your local MongoDB has been recorded yet. Run: node --env-file=.env db-sync.js');
  else {
    const age = now - f.backup.at;
    if (age > 30 * DAY) add('bad', 'backup-old', `Last backup to MongoDB was ${Math.round(age / DAY)} days ago. Run: node --env-file=.env db-sync.js`);
    else if (age > 7 * DAY) add('warn', 'backup-old', `Last backup to MongoDB was ${Math.round(age / DAY)} days ago. Run: node --env-file=.env db-sync.js`);
    if (f.backup.warnings && f.backup.warnings.length) add('warn', 'backup-warnings', `The last backup finished with ${f.backup.warnings.length} warning(s): ${f.backup.warnings[0]}`);
  }

  const bad = msgs.filter(m => m.level === 'bad').length, warn = msgs.filter(m => m.level === 'warn').length;
  const status = bad ? 'bad' : warn ? 'warn' : 'ok';
  const lastWrite = Math.max(e.lastSaveAt || 0, e.lastFlushAt || 0) || null;
  const headline = status === 'ok' ? `Data OK${lastWrite ? ' · saved ' + ago(lastWrite, now) : ''}` : `Data: ${bad ? bad + ' problem' + (bad > 1 ? 's' : '') : ''}${bad && warn ? ', ' : ''}${warn ? warn + ' warning' + (warn > 1 ? 's' : '') : ''}`;
  return { status, headline, messages: msgs, rows, today, lastWrite, lastWriteText: ago(lastWrite, now), backupText: f.backup ? ago(f.backup.at, now) : 'never', logs: f.logs || [], redis: f.redis, backup: f.backup, engine: { ...e, lastSaveText: ago(e.lastSaveAt, now), lastFlushText: ago(e.lastFlushAt, now) }, checkedAt: now };
}

// ---------- gather the facts ----------
async function pipeline(cfg, cmds) {
  const r = await fetch(cfg.upstashUrl + '/pipeline', { method: 'POST', headers: { Authorization: 'Bearer ' + cfg.upstashToken }, body: JSON.stringify(cmds), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(j)) throw new Error((j && j.error) || 'HTTP ' + r.status);
  return j.map(x => (x.error ? null : x.result));
}

async function tradingDaysFrom(engine, now) {
  const today = dayStr(now);
  try {
    const bars = await engine.provider.daily(engine.cfg.indexSymbol, '9999-12-31');   // completed daily bars of the index
    const days = [...new Set(bars.map(b => dayStr(b.t)))].filter(d => d <= today).sort();
    if (days.length >= 5) {
      // today only counts once the index has traded today
      const todayTraded = days.includes(today) || (engine.S && engine.S.tradingDay && engine.S.day === today);
      return { days: [...new Set([...days.filter(d => d < today), ...(todayTraded ? [today] : [])])].slice(-10), known: true };
    }
  } catch (e) { /* fall through to weekdays */ }
  const out = []; for (let k = 0; out.length < 10 && k < 20; k++) { const d = dayStr(now - k * DAY); if (weekday(now - k * DAY) && (d < today || minuteOfDay(now) >= 9 * 60 + 20)) out.unshift(d); }
  return { days: out, known: false };
}

// Redis facts only (cache these for a few minutes). Returns null when no Redis is configured.
async function collectFacts(engine, now = Date.now()) {
  const cfg = engine.cfg;
  if (!cfg.upstashUrl) return null;
  const td = await tradingDaysFrom(engine, now);
  const L = n => engine.listKey(n);
  const logSpecs = [['days', 'Day records', L('days')], ['trades', 'Day-bot trades', L('trades')], ['signals', 'Breakout signals', L('signals')],
    ['v5', 'V5 trades', 'paper-trader:v5:trades'], ['mbook', 'Swing book days', 'paper-trader:mbook:days'], ['scans', 'Mover scans', 'paper-trader:movers:scans'], ['chain', 'F&O option-chain log', 'paper-trader:fno:chain']];
  const cmds = [['INFO']];
  const idx = { info: 0 };
  idx.days = cmds.push(['LRANGE', L('days'), -14, -1]) - 1;
  idx.exists = {};
  for (const d of td.days) { idx.exists[d] = [cmds.push(['EXISTS', L('candles:' + d)]) - 1, cmds.push(['EXISTS', L('bars5m:' + d)]) - 1]; }
  idx.logs = logSpecs.map(([id, , key]) => [cmds.push(['LLEN', key]) - 1, cmds.push(['LINDEX', key, -1]) - 1]);
  idx.backup = cmds.push(['GET', 'paper-trader:backup:last']) - 1;

  let res;
  try { res = await pipeline(cfg, cmds); }
  catch (e) { return { redis: { ok: false, error: e.message }, tradingDays: td.days, tradingDaysKnown: td.known, have: { dayRecord: new Set(), candles: new Set(), bars5m: new Set() }, logs: [], backup: null, collectedAt: now }; }
  const info = String(res[idx.info] || ''), used = +(/used_memory:(\d+)/.exec(info) || [])[1], max = +(/maxmemory:(\d+)/.exec(info) || [])[1];
  const parse = s => { try { return JSON.parse(s); } catch (e) { return null; } };
  const have = { dayRecord: new Set(), candles: new Set(), bars5m: new Set() };
  for (const s of res[idx.days] || []) { const d = dayOf(parse(s)); if (d) have.dayRecord.add(d); }
  for (const d of td.days) { if (res[idx.exists[d][0]]) have.candles.add(d); if (res[idx.exists[d][1]]) have.bars5m.add(d); }
  const logs = logSpecs.map(([id, label], k) => { const last = parse(res[idx.logs[k][1]]); return { id, label, items: Number(res[idx.logs[k][0]]) || 0, lastDay: dayOf(last), lastAt: timeOf(last) }; });
  const b = parse(res[idx.backup]);
  const redis = { ok: Number.isFinite(used), usedMb: used / 1048576, maxMb: max ? max / 1048576 : null, error: Number.isFinite(used) ? undefined : 'no memory figure returned' };
  return { redis, tradingDays: td.days, tradingDaysKnown: td.known, have, logs, backup: b && b.at ? { ...b, at: Date.parse(b.at) } : null, collectedAt: now };
}

// Facts + the live in-process heartbeat, judged at time `now`.
function view(facts, engine, now = Date.now(), extra = {}) {
  if (!facts) return { enabled: false, reason: 'No Redis database is configured (local mode), so there is nothing to check.' };
  const today = dayStr(now);
  return { enabled: true, factsAgeMs: now - facts.collectedAt, ...assess({ ...facts, now, uptimeMs: process.uptime() * 1000, engine: { ...engine.db, outbox: engine.S.outbox.length }, tradingToday: facts.tradingDaysKnown ? facts.tradingDays.includes(today) : undefined, ...extra }) };
}

async function collect(engine, now = Date.now()) { return view(await collectFacts(engine, now), engine, now); }

module.exports = { assess, collect, collectFacts, view, dayOf, timeOf, ago, KEPT_SINCE };
