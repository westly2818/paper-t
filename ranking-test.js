// Does the morning stock ranking add anything, and is a shortlist of 6 a sensible size?
// Runs the REAL live Engine (lib/engine.js, unchanged) on Fyers history: 5-minute bars turned into 1-minute bars (open to first
// extreme to second extreme to close, so stop and target timing inside a 5-minute bar is approximate), daily bars for the ranking.
// The only things replaced are the data feed, the clock, and (for the control runs) the stock selection step:
//   --mode top     the live ranking (default)
//   --mode random  the same eligible stocks, picked at random (a control: if it does as well, the ranking adds nothing)
//   --mode worst   the lowest-ranked eligible stocks (a control: if ranking works, this should do worse)
//   node --max-old-space-size=6000 ranking-test.js --name top6 --shortlist 6 [--mode top] [--from 2024-12-01] [--to 2026-10-01]
//   --set key=value       override any engine setting for the whole run (repeatable): numbers, true/false, or HH:MM for the ...Min times
//                         e.g. --set lastEntryMin=10:00 --set breakevenR=1 --set useIndexFilter=false
//   --minconf N           only enter when the setup's confidence score is at least N (a stand-in for a live gate; a skipped setup stays
//                         on the watch list and can still enter on a later candle)
// The news check cannot be replayed, so it is off, as in any replay. Each day starts with the starting capital.
const fs = require('fs');
const path = require('path');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const NAME = arg('name', 'top6'), SHORT = +arg('shortlist', 6), MODE = arg('mode', 'top');
const DIR5 = arg('dir', 'data/fyers-5m'), DIRD = arg('daily', 'data/fyers-daily-10y'), FROM = arg('from', '0000-00-00'), TO = arg('to', '9999-99-99');
const SETS = {};
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] !== '--set') continue;
  const [k, ...rest] = process.argv[i + 1].split('='), v = rest.join('=');
  const hm = /^(\d{1,2}):(\d{2})$/.exec(v);
  SETS[k] = v === 'true' ? true : v === 'false' ? false : hm ? +hm[1] * 60 + +hm[2] : !isNaN(+v) ? +v : v;
}
const MINCONF = +arg('minconf', 0);
const OUT = path.join(__dirname, 'data', 'ranking-' + NAME);
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });

// --- control selections (patched in before the engine loads) ---
const planner = require('./lib/planner');
const realPick = planner.pickStocks;
let seed = 424242; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
planner.pickStocks = (infos, cfg, equity) => {
  if (MODE === 'top') return realPick(infos, cfg, equity);
  const all = realPick(infos, { ...cfg, shortlistSize: 100000 }, equity);          // every eligible stock, ranked
  let ok = all.picked.slice();
  if (MODE === 'random') for (let i = ok.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [ok[i], ok[j]] = [ok[j], ok[i]]; }
  else if (MODE === 'worst') ok.reverse();
  const n = cfg.shortlistSize;
  return { picked: ok.slice(0, n), rejected: all.rejected.concat(ok.slice(n).map(i => ({ sym: i.sym, why: 'Ranked below the shortlist' }))) };
};

const base = require('./config');
const { Clock } = require('./lib/data');
const { Engine } = require('./lib/engine');
if (MINCONF) {
  const realEnter = Engine.prototype.enter;
  Engine.prototype.enter = function (plan, leg, side, ref, startT, reason, ctx) {
    if (ctx && ctx.confidence && ctx.confidence.score < MINCONF) { leg.note = 'Confidence ' + ctx.confidence.score + ' is below ' + MINCONF; return; }
    return realEnter.apply(this, arguments);
  };
}
const { tradeStats } = require('./lib/stats');
const { atMinute, dayKey, minOfDay, CLOSE } = require('./lib/time');

const sleepless = () => {};
const csvFile = (dir, sym) => path.join(dir, (sym === base.indexSymbol ? 'NIFTY' : sym === base.vixSymbol ? 'INDIAVIX' : sym).replace(/[^A-Za-z0-9_&-]/g, '_') + '.csv');
const readRows = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').slice(1).filter(Boolean).map(l => l.split(',')) : null);

class FyersProvider {
  constructor(clock) { this.clock = clock; this.offline = true; this.dailyMem = new Map(); this.fiveMem = new Map(); this.minDay = null; this.minMem = new Map(); }
  async daily(sym, beforeDay) {
    let a = this.dailyMem.get(sym);
    if (!a) {
      const rows = readRows(csvFile(DIRD, sym));
      if (!rows) throw new Error('no daily file for ' + sym);
      a = rows.map(r => ({ t: Date.parse(r[0]), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
      this.dailyMem.set(sym, a);
    }
    return a.filter(c => dayKey(c.t) < beforeDay);
  }
  fiveDays(sym) {
    let m = this.fiveMem.get(sym);
    if (!m) {
      m = new Map();
      const rows = readRows(csvFile(DIR5, sym));
      if (!rows) throw new Error('no 5-minute file for ' + sym);
      for (const r of rows) { const t = Date.parse(r[0]), k = dayKey(t); let d = m.get(k); if (!d) { d = []; m.set(k, d); } d.push({ t, o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }); }
      this.fiveMem.set(sym, m);
    }
    return m;
  }
  async intraday(sym, day) {
    if (this.minDay !== day) { this.minDay = day; this.minMem = new Map(); }
    let m1 = this.minMem.get(sym);
    if (!m1) {
      m1 = [];
      for (const b of this.fiveDays(sym).get(day) || []) {
        const up = b.c >= b.o, p1 = up ? b.l : b.h, p2 = up ? b.h : b.l, v = Math.floor(b.v / 5);
        [[b.o, b.o], [b.o, p1], [p1, p2], [p2, b.c], [b.c, b.c]].forEach(([o, c], i) => m1.push({ t: b.t + i * 60000, o, c, h: Math.max(o, c, i === 2 ? b.h : -Infinity), l: Math.min(o, c, i === 2 ? b.l : Infinity), v }));
      }
      this.minMem.set(sym, m1);
    }
    const now = this.clock.now();
    return m1.filter(c => c.t + 60000 <= now);
  }
}

(async () => {
  const clock = new Clock('replay', 60);
  const provider = new FyersProvider(clock);
  const nifty = provider.fiveDays(base.indexSymbol);
  const days = [...nifty.keys()].filter(k => nifty.get(k).length >= 74 && k >= FROM && k <= TO).sort();
  console.log(`name=${NAME} mode=${MODE} shortlist=${SHORT} sets=${JSON.stringify(SETS)} minconf=${MINCONF} sessions=${days.length} (${days[0]} to ${days[days.length - 1]})`);
  const cfg = { ...base, mode: 'replay', newsGuard: false, newsAuto: false, upstashUrl: null, stateFile: path.join(OUT, 'state.json'), shortlistSize: SHORT, ...SETS };
  const all = [], perDay = [];
  for (const day of days) {
    const eng = new Engine(cfg, provider, clock);
    eng.save = async () => {}; eng.saveCandles = async () => {};        // no per-poll or per-day file writes
    let t = atMinute(day, 9 * 60 + 5); const end = atMinute(day, CLOSE + 2);
    clock.now = () => t;
    while (t <= end) { await eng.poll(); if (eng.S.error && !eng.S.watch) break; t += 60000; }
    all.push(...eng.S.closed);
    const s = tradeStats(eng.S.closed);
    perDay.push({ day, trades: s.trades, net: s.net });
    if (perDay.length % 25 === 0) console.log(`  ${perDay.length}/${days.length} sessions, ${all.length} trades so far`);
  }
  const s = tradeStats(all);
  const sum = { name: NAME, mode: MODE, shortlist: SHORT, sets: SETS, minconf: MINCONF, sessions: days.length, trades: s.trades, wins: s.wins, winRate: s.winRate, avgR: s.avgR, expectancy: s.expectancy, pf: s.profitFactor, avgWin: s.avgWin, avgLoss: s.avgLoss, maxLossStreak: s.maxLossStreak, maxDD: s.maxDrawdown, net: s.net, fees: s.fees };
  console.log('SUMMARY ' + JSON.stringify(sum));
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ sum, perDay }));
  process.exit();
})().catch(e => { console.error('RANKING-TEST ERROR', e.stack); process.exit(1); });
