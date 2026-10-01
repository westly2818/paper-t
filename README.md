# Paper Trader (NSE intraday, virtual money)

Automated intraday practice trading. It plans stocks each morning, enters and exits on its own with stop loss, target and trailing stop, and squares everything off by 3:15 pm. No real orders are ever sent.

## Run it
Needs Node.js 18 or newer. No packages to install.

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
4. Entries (9:30 to 10:00 am only, `LAST_ENTRY`; frozen as strategy version 3): needs a 5-minute close beyond the range, correct side of VWAP, non-weak volume, Nifty agreeing, and no chasing.
5. Exits: stop loss, 2R target, stop to breakeven at +1R then trailing, 3:15 pm square-off, and a 3% daily loss limit.

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
When a picked stock's setup dies with no trade, the bot tries backups. Each backup is first checked against today's prices and skipped if its setup is already dead. No backup is tried after `REPLACE_UNTIL` (default `10:30` IST), because late backups rarely have a live setup. Backups per slot: `REPLACE_CANDIDATES` (default 3).

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
Fail closed: a stock with no headlines, a failed fetch, no valid verdict, or a block with no cited headline is "unverified" and is not traded (Settings: "Stock the check could not verify"). An unknown market level cuts risk to 75%. If the Gemini call itself fails, the manual paste box appears with the error and a Retry button. Backups for dead slots are checked the same way. Every result, with reasons and sources, is stored in the daily log.
