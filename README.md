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

## News check with Gemini (optional, live mode)
Set your key, then run live. On Windows PowerShell:

    $env:GEMINI_API_KEY="your-key"; $env:MODE="live"; npm start
    (Mac/Linux:  GEMINI_API_KEY=your-key MODE=live npm start)

At 8:30 am IST the bot makes one Gemini call with Google Search: market-wide event risk (RBI, Fed, Budget, expiry) plus news on each shortlisted stock. Gemini can only make the bot more careful: drop a stock ("avoid"), allow only longs or only shorts, or cut position size and trade fewer stocks on risky days. Verdicts and reasons show on the dashboard and go into the trade journal.
- It is off in replay and demo mode on purpose (today's news would leak the outcome of a past day). NEWS_IN_REPLAY=1 forces it on.
- If the call fails 3 times, trading continues without it. NEWS_REQUIRED=1 makes the bot not trade at all instead.
- GEMINI_MODEL=... overrides the model. Search grounding is billed per search on newer models, so check your Google AI pricing page. One call per day is used.
- The key stays on your machine and is only used by the Node server.

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
4. Entries (until 2:30 pm): needs a 5-minute close beyond the range, correct side of VWAP, non-weak volume, Nifty agreeing, and no chasing.
5. Exits: stop loss, 2R target, stop to breakeven at +1R then trailing, 3:15 pm square-off, and a 3% daily loss limit.

## Things to know
- Data comes from Yahoo Finance's unofficial endpoint. It can be delayed, rate-limited or change without notice. Replay mode only has about 7 days of 1-minute history.
- Market holidays are not hard-coded. If Nifty has no candles for the day, the bot reports "No data today" and stays idle.
- Charges are approximate (brokerage, STT, exchange fees, GST, stamp duty). Slippage is 0.02% on market-type fills.
- With small capital and no leverage, charges take a large share of each trade's profit. Try LEVERAGE=5 to see how much that changes results.
- A paper profit does not guarantee real profit. Run replay on many different days and live paper trading for a few weeks before judging the strategy.
