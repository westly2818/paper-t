// Runs the bot over many days at once and prints the statistics that tell you whether the setup has an edge.
//   npm run backtest                (real data: the ~5 latest sessions Yahoo offers in 1-minute detail)
//   MODE=demo DAYS=60 npm run backtest   (made-up prices, only to test the tooling)
// Each day starts fresh with the starting capital, so days are independent samples.
const fs = require('fs');
const base = require('./config');
const { YahooProvider, DemoProvider, Clock, yf } = require('./lib/data');
const { Engine } = require('./lib/engine');
const { tradeStats, toCsv } = require('./lib/stats');
const { atMinute, dayKey, isWeekday, CLOSE } = require('./lib/time');

const demo = process.env.MODE === 'demo';
const cfg = { ...base, mode: demo ? 'demo' : 'replay' };
const money = n => (n >= 0 ? '+' : '-') + '\u20B9' + Math.abs(n).toFixed(0);

(async () => {
  const clock = new Clock(cfg.mode, 60);
  const provider = demo ? new DemoProvider(clock, cfg) : new YahooProvider(clock, cfg);
  let days = [];
  if (demo) {
    let t = Date.UTC(2025, 5, 2); const n = +process.env.DAYS || 40;
    while (days.length < n) { if (isWeekday(t)) days.push(dayKey(t)); t += 86400000; }
  } else {
    const idx = await yf(cfg.indexSymbol, '1m', '7d');
    const last = new Map();
    for (const c of idx) { const d = dayKey(c.t); last.set(d, Math.max(last.get(d) || 0, c.t)); }
    days = [...last.keys()].filter(d => last.get(d) >= atMinute(d, CLOSE - 8)).sort();
  }
  console.log(`Backtesting ${days.length} sessions (${days[0]} to ${days[days.length - 1]}), capital ${cfg.capital} each day\n`);
  const all = [];
  for (const day of days) {
    const eng = new Engine(cfg, provider, clock);
    let t = atMinute(day, 9 * 60 + 5); const end = atMinute(day, CLOSE + 2);
    clock.now = () => t;
    while (t <= end) { await eng.poll(); if (eng.S.error) { console.log(day, 'error:', eng.S.error); break; } t += 60000; }
    all.push(...eng.S.closed);
    const s = tradeStats(eng.S.closed);
    console.log(`${day}  trades ${String(s.trades).padStart(2)}  net ${money(s.net).padStart(7)}  ${eng.S.watch ? 'Nifty ' + (eng.S.watch.index ? eng.S.watch.index.bias : '?') : ''}`);
  }
  const s = tradeStats(all);
  const f = (v, d = 2) => (v == null ? '-' : v.toFixed(d));
  console.log('\n--- Summary ---');
  console.log(`Trades ${s.trades}  (${s.wins} wins, ${s.losses} losses)  win rate ${f(s.winRate, 0)}%`);
  console.log(`Average win ${f(s.avgWin)}  average loss ${f(s.avgLoss)}  average R ${f(s.avgR)}  expectancy/trade ${f(s.expectancy)}`);
  console.log(`Profit factor ${s.profitFactor === Infinity ? 'inf' : f(s.profitFactor)}  longest losing streak ${s.maxLossStreak}  max drawdown ${f(s.maxDrawdown, 0)}`);
  console.log(`Net after charges ${money(s.net)}  (charges paid ${f(s.fees, 0)})`);
  if (s.trades < 100) console.log(`\nOnly ${s.trades} trades: too few to trust. You need 100 to 200 before judging an edge.`);
  fs.writeFileSync('backtest-journal.csv', toCsv(all));
  console.log('Every trade with its reason saved to backtest-journal.csv');
})().catch(e => { console.error('Backtest failed:', e.message); process.exit(1); });
