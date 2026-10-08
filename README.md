> **Start here: [docs/STUDY-GUIDE.md](docs/STUDY-GUIDE.md)** explains what we store, how to validate it after 30 or more days, and how to tell what is good. Keep it updated whenever something new is stored.

# Paper Trader (NSE intraday, virtual money)

Automated intraday practice trading. It plans stocks each morning, enters and exits on its own with stop loss, target and trailing stop, and squares everything off by 3:15 pm. No real orders are ever sent.

## Run it
Needs Node.js 18 or newer. No packages to install to run the bot (the optional backup tool `db-sync.js` needs one `npm install`, see below).

    npm start                      # replay of the latest real trading day (works any time, even weekends)
    MODE=live npm start            # real prices right now, trades only 9:15-15:30 IST on market days
    MODE=demo npm start            # made-up prices, no internet needed

Open http://localhost:3000

Useful settings (environment variables):

    CAPITAL=20000  LEVERAGE=5  RISK_PCT=1  RR=2  MAX_POS=3  DAILY_LOSS=3  SHORTLIST=6
    ALLOW_SHORT=0 (long only)   INDEX_FILTER=0   TRAILING=0   DAY=2025-03-06 (replay a specific recent day)
    Windows PowerShell:  $env:MODE="live"; npm start

Other settings (watchlist, filters, timings) are in config.js.

## Manual news check (on by default in live mode)
No API, no key. Once the morning plan is ready, the dashboard shows a "Manual news check" box with
a ready-made prompt covering that day's shortlisted stocks (plus a couple of backups). Copy it into
ChatGPT (or any chat AI), paste the reply back into the box, and press Submit. Any stock marked
`false` is dropped from today's shortlist; the bot stays idle ("waiting-news" phase) until you do this.
- It is off in replay and demo mode on purpose (today's news would leak the outcome of a past day). NEWS_IN_REPLAY=1 forces it on. NEWS_GUARD=0 turns it off everywhere.
- A "Skip today" button lets you bypass the check entirely. NEWS_REQUIRED=1 hides that button and forces you to paste an answer before trading starts.
- Nothing leaves your machine except what you paste into ChatGPT yourself.

## India VIX rule (all modes)
Previous-day India VIX at 18 or above cuts risk per trade to 75%; 24 or above cuts it to 50%. Change with VIX_ELEVATED and VIX_HIGH.

## Backtest and journal
    npm run backtest                    # runs the bot over the latest real sessions (Yahoo gives ~5 in 1-minute detail)
    MODE=demo DAYS=60 npm run backtest  # made-up prices, only to test the tooling
Prints win rate, average win/loss, average R, expectancy, profit factor, longest losing streak and drawdown, and saves every trade with its reason to backtest-journal.csv. The live dashboard has the same numbers plus a "Download trade journal" link.

## What it does each day
1. Morning plan: reads daily candles for the watchlist, scores trend (20/50-day averages, RSI), daily range and liquidity, and shortlists the best stocks your capital can hold.
2. First 15 minutes: records the opening range (high and low).
3. Trade plan: writes exact trigger, stop, target and quantity for each stock.
4. Entries (9:30 to 10:30 am only, `LAST_ENTRY`; strategy version 3.1, version 3 stopped at 10:00): needs a 5-minute close beyond the range, correct side of VWAP, non-weak volume, Nifty agreeing, and no chasing.
5. Exits: stop loss, 2R target, stop to breakeven at +0.5R, then at +1.5R the stop trails 1R behind the best price, 3:15 pm square-off, and a 3% daily loss limit.

## Things to know
- Data comes from Yahoo Finance's unofficial endpoint. It can be delayed, rate-limited or change without notice. Replay mode only has about 7 days of 1-minute history.
- Market holidays are not hard-coded. If Nifty has no candles for the day, the bot reports "No data today" and stays idle.
- Charges are approximate (brokerage, STT, exchange fees, GST, stamp duty). Slippage is 0.02% on market-type fills.
- With small capital and no leverage, charges take a large share of each trade's profit. Try LEVERAGE=5 to see how much that changes results.
- A paper profit does not guarantee real profit. Run replay on many different days and live paper trading for a few weeks before judging the strategy.

## Analysis history (kept forever)
In live mode with Upstash Redis (or a local `data/` folder) the bot keeps, separate from the restart state:
- `trades`: one record per closed trade, with entry context (VWAP distance, volume ratio, Nifty state, opening range, gap, stock trend and score, VIX, news verdict), how far it went for and against you (`mfeR`, `maeR`), exit reason, charges and the strategy version.
- `days`: one record per day with the shortlist, rejected stocks and why, every plan's final status and notes, the day's event log and the settings used.
- `candles:YYYY-MM-DD`: the day's 1-minute candles for every stock watched, so changed rules can be re-tested on the same prices later.

Download: `/api/export/trades.csv`, `/api/export/trades.json`, `/api/export/days.json`, `/api/export/candles.json?day=YYYY-MM-DD`. Set `STRATEGY_VERSION` when you change rules, so results can be compared per version. If the server crashes at the wrong moment a trade can be logged twice; dedupe on `day` + `id`.

## Backup stocks
When a picked stock's setup dies with no trade, the bot tries backups. Each backup is first checked against today's prices and skipped if its setup is already dead. No backup is tried after `REPLACE_UNTIL` (default `10:30` IST, same as the last entry time: a backup added later could never enter). Backups per slot: `REPLACE_CANDIDATES` (default 3).

## Restarts
In live mode the full state (open positions with their stops and entry context, plans, news verdicts, pending backups, journal) is saved after every poll and on shutdown (SIGTERM). After a restart the bot reloads it, re-fetches today's candles and catches up on any stop or target hit while it was down.

## Loss protection
The stop moves to breakeven once a trade is `BREAKEVEN_R` in profit (default 0.5R, was 1R), then trails at +1.5R. On the 6 recent sessions this turned one full-loss trade (TIINDIA, reached +0.6R then stopped at -1.1R) into a small loss and hurt no winner, but that is a very small sample. Set `BREAKEVEN_R=1` to go back. `STRATEGY_VERSION` is `2` from this change, so the analysis log can separate the two rule sets.

## Frozen strategy and evaluation
Strategy version 3 changes one thing from version 2: new entries stop at 10:00 (`LAST_ENTRY`, was 14:30). Everything else is unchanged (volume 0.9x, Nifty filter, 0.4% chase limit, 2R target, breakeven at +0.5R, trailing at +1.5R, 15:15 exit, 3 positions, 6 trades, 3% daily stop). Do not change rules on the strength of the first 30 live sessions.
`node --env-file=.env report.js` prints trades, win %, average R, total R, profit factor, max drawdown, long vs short, hold time, 2R hit rate, 15:15 exits and loss streak per strategy version, with a note on how much evidence the session count gives (30 preliminary, 50 meaningful, 100+ strong).

## Settings screen
Open `/settings` in the app to change risk, entry, exit, stock-selection and news settings. Values are saved in Redis (or `data/settings.json` locally) as overrides of the defaults in `config.js`, are loaded before the server accepts requests, and apply immediately to new decisions (open trades and plans already built keep their levels). Every change is logged with time, old value and new value (`/api/settings/log`), and every trade stores the full rule set it ran under. Only `MODE` and the two Upstash connection values stay in the environment.
The screen has no password, like the rest of the dashboard: anyone with the URL can change settings.

## Automatic news check (Gemini)
Set `GEMINI_API_KEY` (or `LLM_API_KEY_FREE`) in the environment and keep "Automatic news check" on in Settings. Each morning the bot fetches the last 36 hours of headlines for each shortlisted stock (Google News RSS, searched by full company name, exact publish times) and has Gemini classify them. Gemini's own Google Search tool is not used: it hits the free-tier quota (429). Sources shown on the dashboard are the headlines we fetched, never links the model wrote. The market-wide level (normal, elevated, high) is judged from market headlines.
Fail closed: a stock with no headlines, a failed fetch, no valid verdict, or a block with no cited headline is "unverified" and is not traded (Settings: "Stock the check could not verify"). An unknown market level cuts risk to 75%. Since version 3.3 an "elevated" call no longer cuts size (a 126-session test found elevated days no more volatile than normal days, and the call fired on 83% of days); "high" still cuts to 50% with 2 positions. The old cut returns with the setting "Cut size when the news check says elevated" or ELEVATED_MARKET_CUT=1. If the Gemini call itself fails, the manual paste box appears with the error and a Retry button. Backups for dead slots are checked the same way. Every result, with reasons and sources, is stored in the daily log.

## Exact rule definitions (strategy version 3)
- Risk and size: `RISK_PCT` is the maximum risk, 1% of equity (cut to 75% / 50% by VIX). Quantity = min(risk / stop distance per share, 50% allocation cap / price). With 20,000 capital the cap often binds, so real risk is usually 0.2% to 0.6% of equity.
- Initial stop: the opening-range midpoint. The distance from the trigger is then clamped to 0.4% to 1.2% of price, so after clamping the stop may not sit at the midpoint. Target = 2 x that distance.
- Volume ratio: the breakout 5-minute candle's volume divided by the average volume of all of that day's closed 5-minute candles so far, counting the opening-range candles (9:15 to 9:30) and the breakout candle itself. Must be at least 0.9. The live preview on the dashboard uses the same function (`volumeRatio` in `lib/indicators.js`), with the still-forming candle counted as the current one; `npm test` checks that preview and decision agree.
- Nifty agrees: the latest Nifty 50 price is above Nifty's VWAP for a long, below it for a short.
- Breakeven and trailing: at +0.5R the stop moves to the entry price. At +1.5R the stop trails 1R behind the best price reached. The 2R target is still active, so the trail only matters between +1.5R and +2R.
- Not changed in V3, candidates for V4 after 50+ live sessions: breakout-candle stop with the 0.4-1.2% band as a filter, volume vs the same time slot on past days.

## Shadow test: breakeven at +1R
`node --env-file=.env be-shadow.js` (or `--dir data`) replays every logged trade on the saved 1-minute candles with breakeven at +0.5R (V3) and at +1R, and prints total R, average R, win rate, how often V3 was stopped at breakeven and price then still reached 2R. It changes nothing in live trading.

## Comparing strategies (strategies.js)
The live bot trades V3 only, but it logs every breakout candle (taken or rejected) with all its conditions and the volume baseline (`rvolSlot` = breakout candle vs the same 5-minute slot over up to 20 earlier sessions, `rvolCum` = the morning so far vs the same period, `gapPct`), and saves the day's 1-minute candles. `node --env-file=.env strategies.js` (or `--dir data`, `--since YYYY-MM-DD`) then runs several rule sets on those same signals with exact 1-minute exits: V3, breakeven at +1R, no breakeven, RVOL and gap filters, and a V4 candidate. Add a line to `VARIANTS` in the file to test another. It prints trades, win %, average R with a 95% range, total R and profit factor per variant, plus how much evidence there is. Volume features exist only for sessions after this change. Study only: the baseline never affects a live decision.
After one week (about 5 sessions) V3 will have a handful of trades, so the 95% ranges will overlap and no variant can be called better. Expect a first real hint at 30 trades and a decision at 100+.

## Shadow logging of news-blocked stocks (shadow-news.js)
When the news check removes a shortlisted stock (adverse news, or "unverified"), the bot now keeps that stock's daily info in the day's record (`shadow`) and still saves its 1-minute prices. It never trades it. `node --env-file=.env shadow-news.js` (or `--dir data`, `--since YYYY-MM-DD`) replays each removed stock's day with the live entry and exit rules and compares the would-have trades with the trades the bot really took, so you can see whether the news check protects you or costs you trades. Only sessions after this change have a shadow list. Groups under about 30 trades each are noise. `npm test` checks that an avoided stock is recorded.

## Breakout freshness and slope (study only)
Each signal and trade now also carries `crossedBefore` (earlier closed 5-minute candles after the opening range that already closed beyond the trigger; 0 = fresh breakout), `freshBreakout`, `priceSlope15m` and `vwapSlope15m` (% move over the last 15 minutes, in the trade direction) and `breakoutTime`. They never change a decision. `strategies.js` has two variants that split V3's trades into fresh breakouts and late ones. The backtest (440 sessions) saw fresh breakouts beat late ones in both the development and holdout halves, but fresh-only was still about zero after costs, so it is a question for the forward sample: watch whether late breakouts are consistently bad, which would justify simply skipping second and third attempts.

## Strategy lab and the 5-minute archive
`node lab.js` tests five all-day candidates (relative-strength pullback, VWAP fade, late momentum, midday consolidation breakout, failed-ORB reversal) plus two calibration rows (the live ORB logic and a random-entry control) on the whole Nifty 200, using Yahoo's free 5-minute history (about 56 sessions). Parameters are fixed in the file header; do not tune them after seeing a result. Charges are the real MIS charges plus 0.02% slippage, so every R is net of costs, and `grossR` is before costs.
First result (56 sessions to 1 Oct 2026): the random-entry control loses 0.16R per trade after costs, and none of the five candidates earns more than about +0.08R before costs, so none breaks even. The live ORB logic on every eligible stock (no top-6 selection) is worse than random before costs, so any live edge comes from the morning stock ranking.
After every close the bot saves the 5-minute bars of all Nifty 200 stocks, Nifty and India VIX (about 100 KB a day, compressed) to Redis as `bars5m:<day>` (`/api/export/bars5m.json?day=YYYY-MM-DD`). Yahoo only keeps about 60 days, so this grows our own dataset for the lab.

## Swing portfolio (paper only, month-long holds, separate from the day-trading bot)
Shown on the Swing tab. In the code it is still called the momentum book (`lib/momentum.js`, `mbook` keys), because it ranks stocks by 12-month momentum.
`lib/momentum.js` runs a second paper portfolio on its own timer and its own Redis keys (`paper-trader:mbook:state`, `:trades`, `:days`). It never imports or calls the opening-range engine, and an error inside it is caught and logged there. Dashboard: the Swing tab (`/api/mbook`, trades at `/api/mbook/trades.json`).
Rules (swing-study.js M1): on the first trading day of each month, at 10:30 (any time up to 15:00), rank the Nifty 200 by 12-month return skipping the last month, using completed daily bars. Eligible: 20-day turnover over Rs 30 crore, price under Rs 8,000, no one-day move over 35% in the last year, 260+ sessions. If Nifty's last close is below its 200-day average, sell everything and hold cash. Otherwise hold the top 10 in equal amounts (paper capital Rs 50,000, set in config.js). Holdings that stay in the top 10 are kept; leavers are sold; entrants are bought with equity / 10 each. Delivery charges and 0.05% slippage; no stops, no leverage.
After the close (from 15:50) it marks the portfolio to market and prepares the next pick list from complete daily bars, so the 10:30 rebalance only needs about 20 live prices. A failed price fetch changes nothing and is retried each minute until 15:00.
`npm run momentum-sim` replays the same code over 10 years of Fyers daily data (download with `fyers-download.js --res D --months 120`). On that data it gives 21.8%/yr with a 33% maximum drawdown (the study's M1 gave 20.7% and 33%), against Nifty 9.0%/yr. The universe is today's Nifty 200, so these figures are optimistic; the back-test did not show the strategy beats simply holding the same stocks.

## Confidence score (Entry watch)
Each waiting setup shows a confidence score from 0 to 100 with a per-part breakdown: daily trend matches the trade (20), stronger/weaker than Nifty in the trade direction (20), healthy volume, 0.9x to 2x (15), Nifty agrees (15), right side of VWAP (10), beyond yesterday's high/low (5), news check clear (10), normal-risk day (5). Very high volume (2x or more) earns nothing, because it did worse in past replays. It also shows how many of the entry conditions are met right now. It is a checklist, not a probability of profit, and it never blocks or changes a trade. The weights come from 1,906 replayed trades (Oct 2024 to Oct 2026): the best fifth beat the worst fifth by about 0.1R, no tier was profitable, and it was calibrated on the same data it was checked on, so re-check it on live trades (`lib/confidence.js`). The score at every closed candle is saved with each signal and trade, so it can be calibrated against real results once there are enough live trades.

## Two-year settings sweep (ranking-test.js, sweep-report.js)
`ranking-test.js` runs the real engine on 24 months of Fyers 5-minute history (494 sessions); `sweep-report.js` compares 13 one-change variants with the baseline on the same sessions. Result (no news filter, charges included): the live rules lose about Rs 2,100 over two years (gross +Rs 1,675, charges Rs 3,776), and no tested change (entry cutoff 10:00/11:30/14:30, breakeven 0.25R/1R, target 1.5R/3R, no Nifty filter, volume 0.75x/1.2x, confidence gate 85, no trailing, long only) turned it profitable. Stock ranking beats random selection (-0.08R vs -0.15R per trade) but ranks 1-10 are equivalent. The two least-bad variants, breakout volume >= 1.2x and confidence >= 85, are also in `strategies.js` so live signals can confirm or reject them.

## Mover scanner (a study, never trades)
`lib/movers.js` runs on its own timer and its own storage keys (`paper-trader:movers:*`); it never touches the opening-range engine or the swing portfolio. Each trading morning from 09:38 it lists Nifty 200 stocks that are 2% or more away from yesterday's close at 09:35, with early volume against the stock's own 20-session usual, and asks Gemini (`lib/catalyst.js`) whether news published BEFORE 09:35 gives a real company-specific reason (the same fetch-then-classify design as the news check: our own headlines, cited evidence, unverifiable means "unverified"). After 15:45 it records what each mover did to 10:30, 12:00, 13:30, 15:15 and the close, in the mover's own direction and minus Nifty. The Movers tab shows today's list, the outcomes, and a study table by group (volume, news reason, news category, size of the gap, up vs down), with the day-clustered t-statistic and the result after charges (about 0.14%). Data: `/api/movers`, `/api/movers/scans.json`, `/api/movers/outcomes.json`.
`movers-backfill.js` runs the same rules over Fyers 5-minute history (add `--news-days 60` to classify recent sessions with date-limited headlines, nothing published after 09:35). First result on 484 sessions (9,095 movers): on average big opening moves do NOT keep going (+0.02% to 15:15, 49% still going, -0.12% after charges, volume made no difference). Only moves of 6% or more looked different (+0.44%, 372 movers, positive in both halves) but the median is only +0.15%, 77% of the gain comes from the best 10 trades, and the universe is today's Nifty 200, so it is a lead to confirm on live data, not a result.
With news (last 60 sessions, 894 movers, headlines published before 09:35 only): a news reason did not help (+0.05% to 15:15 with a reason, -0.02% without, both below charges); strong volume plus a news reason was +0.17% (+0.03% after charges, t 0.3). By category, "corporate action" faded (-0.48%, t -3.2) and "regulatory or legal" continued (+0.75%, t 2.0), but those are small groups among eight and need live confirmation.

## Backup to your own MongoDB (db-sync.js)
`node --env-file=.env db-sync.js` copies everything the apps keep in Upstash Redis into your local MongoDB (default `mongodb://127.0.0.1:27017`, database `paper_trader`; set `MONGODB_URI` / `MONGODB_DB` to change). Add `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (the same two values Render uses) to `.env`, and run `npm install` once for the `mongodb` driver.
It is incremental. It first prints what MongoDB already has and how far it goes (per list: items and "data until" date; per price archive: days covered), then copies only what is newer: list items from the first one not stored yet (after checking the item before it is unchanged), price archives for days not stored yet, and the latest copy of state keys. Nothing is ever deleted. If a Redis list is shorter than the stored copy or an old item changed, it warns and keeps the local copy (`--full` re-copies). `--status` shows what MongoDB has without touching Redis. `--export data/db-export` writes files the analysis scripts read (`node strategies.js --dir data/db-export`). The older `db-backup.js` still works (it re-downloads every list each time and writes JSON files). Collections: `lists`, `blobs`, `kv`, `sync_log`. `npm test` runs a sync against a fake Upstash and a throwaway database (skipped if MongoDB is not running).
