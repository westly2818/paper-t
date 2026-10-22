// End-of-cycle decision report. Applies the locked deployment gate (lib/deploygate.js, docs/DEPLOYMENT_GATE.md) to the live paper records and prints one decision block.
//   node --env-file=.env cycle-report.js [--since 2026-10-09]        saves data/cycle-<date>.txt
// Nothing here places orders. No field is invented: anything that cannot be verified is printed as UNAVAILABLE with the consequence.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const G = require('./lib/deploygate');
const cfg = require('./config');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const SINCE = arg('since', '2026-10-09');
const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
const IST = 5.5 * 3600e3, D = ms => new Date(ms + IST).toISOString().slice(0, 10), HM = ms => new Date(ms + IST).toISOString().slice(11, 16);
const out = []; const say = s => { out.push(s); console.log(s); };
const call = async cmd => { const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: JSON.stringify(cmd), signal: AbortSignal.timeout(20000) }); const j = await r.json(); if (j.error) throw new Error(j.error); return j.result; };
const list = async k => (await call(['LRANGE', k, 0, -1])).map(JSON.parse);
const blob = async day => { const raw = await call(['GET', 'paper-trader:state:bars5m:' + day]); return raw ? JSON.parse(zlib.gunzipSync(Buffer.from(raw, 'base64')).toString()) : null; };

(async () => {
  if (!url) { console.error('Run with: node --env-file=.env cycle-report.js'); process.exit(1); }
  const ledger = JSON.parse(fs.readFileSync(path.join(__dirname, 'docs', 'evidence-ledger.json'), 'utf8')).strategies;
  const now = Date.now();
  let halt = null;

  // ---- market status from the latest archived day
  let ms = { label: 'UNCERTAIN', why: 'no archived Nifty bars' }, dataAt = null, latestDay = null;
  try {
    const keys = (await call(['KEYS', 'paper-trader:state:bars5m:*'])).sort(); latestDay = keys.length ? keys[keys.length - 1].split(':').pop() : null;
    if (latestDay) {
      const b = await blob(latestDay), nifty = b && b['^NSEI'], vixBars = b && b['^INDIAVIX'];
      ms = G.marketStatus(nifty, vixBars && vixBars.length ? vixBars[vixBars.length - 1][4] : null, { vixHigh: cfg.vixHigh });
      dataAt = nifty && nifty.length ? `${latestDay} ${HM(nifty[nifty.length - 1][0])} IST (last archived 5-minute bar)` : null;
    }
  } catch (e) { halt = 'Redis or data read failed: ' + e.message; }

  // ---- kind of each trading day (Nifty close-to-close beyond +-0.3%): needs the day before, taken from the archive
  const kindByDay = {}; const closes = {};
  try {
    for (const k of (await call(['KEYS', 'paper-trader:state:bars5m:*'])).sort()) { const d = k.split(':').pop(); const b = await blob(d); const n = b && b['^NSEI']; if (n && n.length) closes[d] = n[n.length - 1][4]; }
    const ds = Object.keys(closes).sort();
    ds.forEach((d, i) => { if (i === 0) return; const m = (closes[d] / closes[ds[i - 1]] - 1) * 100; kindByDay[d] = m > G.GATE.flatPct ? 'up' : m < -G.GATE.flatPct ? 'down' : 'flat'; });
  } catch (e) { /* kinds stay empty: G3 will then fail honestly */ }

  // ---- live rows
  const v5 = JSON.parse(await call(['GET', 'paper-trader:v5:state'])).closed.filter(t => D(t.openedAt) >= SINCE).map(t => {
    const risk = t.qty * t.entry * (t.stopPct / 100), slip = t.exitReason === 'stop' ? 0.25 * risk : 0;
    return { day: D(t.closedAt), sym: t.sym, opened: t.openedAt, r: t.rNetSlip != null ? t.rNetSlip : (t.netPnL - slip) / risk, chargesR: t.charges / risk };
  });
  const seen = new Set();
  const orb = (await list('paper-trader:state:trades')).filter(t => { const k = t.day + ':' + t.id; if (seen.has(k)) return false; seen.add(k); return true; })
    .map(t => ({ day: t.day, sym: t.sym, opened: t.tIn, r: t.rMultiple, chargesR: t.riskAmount ? t.fees / t.riskAmount : 0 }));
  const iss = await list('paper-trader:iss:trades');
  let fno = []; try { fno = JSON.parse(await call(['GET', 'paper-trader:fno:state'])).closed || []; } catch (e) { /* none */ }
  let shadow = null; try { shadow = JSON.parse(await call(['GET', 'paper-trader:shadow:summary'])); } catch (e) { /* none */ }
  let shadowStatus = null; try { shadowStatus = JSON.parse(await call(['GET', 'paper-trader:shadow:status'])); } catch (e) { /* none */ }
  let paperCapital = cfg.capital; try { const st = JSON.parse(await call(['GET', 'paper-trader:state:settings'])); if (st && st.capital) paperCapital = st.capital; } catch (e) { /* config default */ }
  const hbAgeH = shadowStatus && shadowStatus.at ? (now - Date.parse(shadowStatus.at + '+05:30')) / 3600e3 : null;

  const results = [];
  for (const [id, rows, shadowFlag] of [['v5', v5, false], ['orb', orb, false]]) {
    const m = G.metrics(rows, kindByDay), crit = G.evaluate(m, { hist: ledger[id].hist, attest: null });
    results.push({ id, label: ledger[id].label, m, crit, disp: G.disposition(crit, { shadow: shadowFlag }), caveat: ledger[id].caveat });
  }
  const fixed = (id, forward, extra = {}) => ({ id, label: ledger[id].label, forward, disp: { code: id === 'ml' ? 'REJECT STRATEGY (research models); KEEP IN SHADOW (frozen baseline)' : 'KEEP IN PAPER', why: 'missing: ' + (ledger[id].requirement || '') }, ...extra });
  const others = [
    fixed('iss', `${iss.length} trades, net ${Math.round(iss.reduce((a, t) => a + (t.net || 0), 0))} Rs`),
    fixed('fno', `${fno.length} closed, net ${Math.round(fno.reduce((a, t) => a + (t.net || 0), 0))} Rs`),
    fixed('swing', 'holds cash while Nifty is below its 200-day average'),
    fixed('ml', shadow ? `shadow: ${shadow.decisions_predicted} decisions predicted, ${shadow.decisions_missed} missed` : 'shadow service has recorded nothing'),
  ];

  const passed = results.filter(r => r.disp.code === 'DEPLOYMENT GATE PASSED');
  const outcome = halt ? 'HALT SYSTEM' : passed.length ? 'DEPLOYMENT GATE PASSED' : 'NO TRADE TODAY';
  const f = (v, d = 3) => (v == null ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(d));

  say(`CYCLE REPORT  ${new Date(now + IST).toISOString().replace('T', ' ').slice(0, 16)} IST   (records since ${SINCE} for V5; all day-bot trades)\n`);
  say(`MARKET STATUS: ${ms.label}   (${ms.why}; rule: HIGH VOLATILITY if VIX >= ${cfg.vixHigh} or range >= 2.5%; TRENDING if efficiency >= 0.5 and range >= 0.6%; RANGING if efficiency < 0.3; otherwise UNCERTAIN. Informational, not a trade filter.)`);
  say(`TRADING DECISION: ${outcome === 'NO TRADE TODAY' ? 'NO TRADE' : outcome === 'HALT SYSTEM' ? 'WAIT' : 'NO TRADE (a passed gate authorises a separately approved trial, never an order from this report)'}`);
  say('INSTRUMENT: NONE');
  say(`SETUP: none qualifies. No strategy has passed the deployment gate (criteria locked in docs/DEPLOYMENT_GATE.md), so no entry conditions are published.`);
  say('ENTRY: UNAVAILABLE (no approved setup). Consequence: nothing to execute.');
  say('STOP-LOSS: UNAVAILABLE (no approved setup).');
  say('TARGET / EXIT: UNAVAILABLE (no approved setup).');
  say(`QUANTITY: UNAVAILABLE. Real trading capital, the approved risk fraction and broker permissions are not configured anywhere in this system (the Rs ${Number(paperCapital).toLocaleString('en-IN')} in the live settings is a paper-simulation parameter, not account data). Sizing rule once configured: shares = floor(capital x approved risk fraction / (stop distance + costs + execution allowance)).`);
  say(`ESTIMATED COSTS (reference, per round trip): charges about 0.10 to 0.14% of traded value (about 0.13R per trade at these stops), modelled slippage ${cfg.slippagePct}% a side, spread not modelled separately. Not applied to any order today.`);
  say('EXPECTED NET REWARD/RISK: UNAVAILABLE for a new trade. Measured after costs: ' + results.map(r => `${r.label.split(' (')[0]} ${f(r.m.avgR, 2)}R over ${r.m.n || 0} trades`).join('; ') + '.');
  say(`EVIDENCE: data as of ${dataAt || 'UNAVAILABLE'}; records read ${new Date(now + IST).toISOString().slice(11, 16)} IST. Backtest evidence, sample sizes and out-of-sample results are in the table below.`);
  say('CONFIDENCE: NOT CALIBRATED');
  say('EXECUTION STATUS: Paper (V5, day bot, ISS, F&O, Swing); Shadow (ML baseline, ' + (shadowStatus ? (hbAgeH > 24 ? 'SERVICE NOT RUNNING: last heartbeat ' + shadowStatus.at + ' IST, ' + Math.round(hbAgeH) + ' hours ago' : 'last heartbeat ' + shadowStatus.at + ', state ' + shadowStatus.state) : 'no heartbeat recorded') + '). Live ordering: not implemented, not authorised.');
  say(`REASON: ${halt ? halt : passed.length ? 'a strategy met every gate criterion' : 'no strategy passes the gate; ' + results.filter(r => r.disp.code === 'REJECT STRATEGY').map(r => r.label.split(' (')[0]).join(' and ') + ' fail the historical out-of-sample test outright; the others lack forward evidence.'}`);
  say('NEXT ACTION: ' + (results.some(r => r.disp.code === 'REJECT STRATEGY') ? 'confirm the REJECT dispositions below and stop treating V5 and the day bot as capital candidates (they may keep running as paper measurements at no cost).' : 'run this report after the next close.'));

  say('\n=== DISPOSITIONS (end of cycle) ===');
  for (const r of results) {
    say(`\n${r.label}\n  DISPOSITION: ${r.disp.code}\n  ${r.disp.why}`);
    if (r.caveat) say('  Caveat: ' + r.caveat);
    for (const c of r.crit) say(`  [${c.status.padEnd(11)}] ${c.id} ${c.name}\n               ${c.detail}`);
  }
  for (const r of others) say(`\n${r.label}\n  DISPOSITION: ${r.disp.code}\n  Forward record: ${r.forward}\n  ${r.disp.why}`);
  say(`\nCYCLE OUTCOME: ${outcome}. No strategy is eligible for real capital. Real execution (broker verification, order types, acknowledgements, partial fills, protective exits, reconciliation, human approval gate) is a later stage that starts only after a DEPLOYMENT GATE PASSED and your separate authorisation.`);
  fs.mkdirSync('data', { recursive: true });
  const file = path.join('data', `cycle-${D(now)}.txt`); fs.writeFileSync(file, out.join('\n')); console.log('\nSaved to ' + file);
})().catch(e => { console.error('CYCLE REPORT ERROR (HALT SYSTEM):', e.message); process.exit(1); });
