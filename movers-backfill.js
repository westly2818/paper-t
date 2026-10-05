// First answer for the mover study from history: the SAME rules as lib/movers.js (stocks 2% or more from yesterday's close at
// 09:35, early volume against the stock's own usual, then what they did to 10:30 / 12:00 / 15:15), on Fyers 5-minute files.
//   node --max-old-space-size=6000 movers-backfill.js --dir data/fyers-5m                       (price part only: 24 months)
//   node --env-file=.env --max-old-space-size=6000 movers-backfill.js --dir data/fyers-5m --news-days 60
//        also classifies the largest movers of the last 60 sessions with the real news check, using ONLY headlines published
//        before 09:35 that day (Google News date search, cached in data/news-cache; Gemini answers cached by prompt).
// Honest limits: today's Nifty 200 members, 5-minute bars, and old Google News coverage is patchy, so "no news reason found"
// partly means "the search did not find it". Charges are about 0.14% for a round trip.
const fs = require('fs');
const path = require('path');
const base = require('./config');
const { sessionsOf, moverFeatures, outcomeOf, summarize, COST_PCT, STRONG_RVOL, MOVE_PCT } = require('./lib/movers');
const { classifyMovers } = require('./lib/catalyst');
const { dayKey } = require('./lib/time');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const DIR = arg('dir', 'data/fyers-5m'), NEWS_DAYS = +arg('news-days', 0), MAX_CLASSIFY = +arg('news-per-day', 50);
const DATA = path.join(__dirname, 'data');

function readBars(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n'), out = [];
  for (let i = 1; i < lines.length; i++) { const r = lines[i].split(','); if (r.length < 6) continue; out.push({ t: Date.parse(r[0]), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }); }
  return out;
}
const pc = (v, d = 2) => (v == null || !isFinite(v) ? '-' : (v >= 0 ? '+' : '') + Number(v).toFixed(d) + '%');

(async () => {
  const nifty = sessionsOf(readBars(path.join(DIR, 'NIFTY.csv')));
  const scans = [], outcomes = [];
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.csv') && !/^(NIFTY|INDIAVIX)\.csv$/.test(f));
  let n = 0;
  for (const f of files) {
    const sym = f.slice(0, -4), sess = sessionsOf(readBars(path.join(DIR, f)));
    for (const day of [...sess.keys()].sort()) {
      if (!nifty.has(day) || !nifty.get(day)[3]) continue;
      const feat = moverFeatures(sess, day);
      if (!feat || Math.abs(feat.movePct) < MOVE_PCT || feat.turnover < base.minTurnover) continue;
      const dir = feat.movePct >= 0 ? 1 : -1, o = outcomeOf(sess.get(day), nifty.get(day), dir);
      if (!o || o.ret.r1515 == null) continue;
      scans.push({ day, sym, dir, movePct: feat.movePct, gapPct: feat.gapPct, rvol: feat.rvol, strongVolume: feat.rvol >= STRONG_RVOL, catalyst: null });
      outcomes.push({ day, sym, dir, ...o });
    }
    if (++n % 40 === 0) process.stdout.write(`  ${n}/${files.length} stocks, ${scans.length} movers\r`);
  }
  const allDays = [...new Set(scans.map(s => s.day))].sort();
  console.log(`\n${files.length} stocks, ${allDays.length} sessions (${allDays[0]} to ${allDays[allDays.length - 1]}), ${scans.length} movers (2% or more from yesterday's close at 09:35)\n`);

  // ---------- optional: real news check on the largest movers of recent sessions ----------
  if (NEWS_DAYS > 0) {
    const key = process.env.GEMINI_API_KEY || process.env.LLM_API_KEY_FREE;
    if (!key) throw new Error('--news-days needs GEMINI_API_KEY or LLM_API_KEY_FREE (use --env-file=.env)');
    const { historicalFetch, setDay, stats } = require('./news-history');
    const { yf, NAMES } = require('./lib/data');
    const nf = path.join(DATA, 'names.json');
    let names = fs.existsSync(nf) ? JSON.parse(fs.readFileSync(nf, 'utf8')) : null;
    if (!names) { names = {}; for (const s of base.watchlist) { try { await yf(s, '1d', '5d', 2); } catch (e) { /* skip */ } if (NAMES.get(s)) names[s] = NAMES.get(s); } fs.writeFileSync(nf, JSON.stringify(names)); }
    const days = allDays.slice(-NEWS_DAYS);
    let done = 0;
    for (const day of days) {
      const today = scans.filter(s => s.day === day).sort((a, b) => Math.abs(b.movePct) - Math.abs(a.movePct)).slice(0, MAX_CLASSIFY);
      if (!today.length) continue;
      setDay(day);
      try {
        const nowMs = Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), 4, 5); // 09:35 IST
        const r = await classifyMovers({ movers: today, names, nowMs, key, model: base.geminiModel, fetchImpl: historicalFetch });
        for (const s of today) s.catalyst = r.byStock[s.sym] || null;
      } catch (e) { console.log(`  ${day}: news check failed (${e.message.slice(0, 80)})`); }
      if (++done % 5 === 0) console.log(`  news: ${done}/${days.length} sessions (rss fetched ${stats.rssFetched}, cached ${stats.rssCached}; gemini fetched ${stats.geminiFetched}, cached ${stats.geminiCached})`);
    }
    // only the classified movers are comparable in the news groups
    const classifiedDays = new Set(days);
    for (const s of scans) if (!classifiedDays.has(s.day) || s.catalyst == null) s.catalyst = null;
  }

  const row = (g, w = 42) => g.n ? `${g.name.padEnd(w)} ${String(g.n).padStart(6)} ${String(g.days).padStart(5)}  ${pc(g.r1030).padStart(7)} ${pc(g.r1200).padStart(7)} ${pc(g.r1515).padStart(7)} ${pc(g.adj1515).padStart(7)}  ${g.win.toFixed(0).padStart(3)}%  ${g.t == null ? '    -' : g.t.toFixed(1).padStart(5)}  ${pc(g.net).padStart(7)}` : `${g.name.padEnd(w)} none`;
  const head = 'group'.padEnd(42) + ' movers  days  to10:30 to12:00 to15:15 vsNifty  kept    t(day)  after charges';
  const S = summarize(scans, outcomes);
  console.log('PRICE-ONLY RESULTS (every mover, all sessions). "kept" = share still going at 15:15. Needs to beat ' + COST_PCT + '% after charges.');
  console.log(head);
  for (const g of S.groups.filter(g => !/^News/.test(g.name) && !/news/i.test(g.name))) console.log(row(g));
  // by size of the move
  console.log('\nBy size of the 09:35 move (up and down together):');
  for (const [lo, hi] of [[2, 3], [3, 4], [4, 6], [6, 99]]) { const sub = summarize(scans.filter(s => Math.abs(s.movePct) >= lo && Math.abs(s.movePct) < hi), outcomes); const g = sub.groups[0]; if (g.n) console.log(row({ ...g, name: `${lo}% to ${hi === 99 ? 'more' : hi + '%'}` }, 42)); }
  // by year, to see whether anything is stable
  console.log('\nBy half (first 12 months vs last 12 months), strong early volume movers:');
  const mid = allDays[Math.floor(allDays.length / 2)];
  for (const [name, f] of [['first half', s => s.day < mid], ['second half', s => s.day >= mid]]) { const sub = summarize(scans.filter(s => s.strongVolume && f(s)), outcomes); if (sub.groups[0].n) console.log(row({ ...sub.groups[0], name }, 42)); }
  if (NEWS_DAYS > 0) {
    const classified = scans.filter(s => s.catalyst);
    const Sn = summarize(classified, outcomes);
    console.log(`\nWITH THE NEWS CHECK (the ${MAX_CLASSIFY} biggest movers a day, last ${NEWS_DAYS} sessions; ${classified.length} movers classified, ${classified.filter(s => s.catalyst.explainsMove === true).length} with a news reason, ${classified.filter(s => s.catalyst.explainsMove === null).length} unverified):`);
    console.log(head);
    for (const g of Sn.groups) console.log(row(g));
  }
  fs.writeFileSync(path.join(DATA, 'movers-backfill.json'), JSON.stringify({ sessions: allDays.length, scans, outcomes: outcomes.length }));
  console.log('\nSaved data/movers-backfill.json');
})().catch(e => { console.error('BACKFILL ERROR', e.stack); process.exit(1); });
