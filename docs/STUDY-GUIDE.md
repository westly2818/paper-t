# Study guide: what we store, how to validate it, and how to tell what is good

This file exists so you can lose the context and get it back in ten minutes. Keep it current: every time something new is stored or a new study is added, update sections 2, 4 and 8 (the maintenance rule is at the bottom).

Last updated: 6 Oct 2026 (added the all-stocks study).

---

## 1. The five-line summary

1. **Day-trading bot (ORB)**: paper-trades the opening-range breakout on 6 stocks, entries 9:30 to 10:30, rules version **3.1**. Live since 1 Oct 2026.
2. **Swing portfolio**: separate paper portfolio, ₹50,000, top 10 momentum stocks, changes once a month, holds cash while Nifty is below its 200-day average. Started 5 Oct 2026.
3. **Mover scanner**: a study that never trades. Logs stocks that jump 2% or more by 9:35 with their news reason, then what they did next. Started 6 Oct 2026.
4. **Archive**: after every close we save 5-minute prices for all Nifty 200 stocks, so we build our own history (Yahoo only keeps about 60 days).
5. **Everything above is paper money.** The honest state of the evidence after two years of replays: the day-trading bot has about **zero edge before charges and loses a little after them**. The purpose of all this logging is to find out, with real data, whether anything is worth trading.

Nothing here has been proven to make money. Do not trade real money on any of it unless a result passes the tests in section 5.

---

## 2. What we store, and where

Everything lives in **Upstash Redis** (the database whose URL and token are in `.env` locally and in Render's environment). Keys all start with `paper-trader:`. Files marked *local* exist only on your computer.

### 2.1 Day-trading bot (ORB)

| Redis key | What it holds | Written | Used by |
|---|---|---|---|
| `paper-trader:state` | Live working state: open positions, plans, news result, today's events. Restored after any restart. | every poll (about 20 s) | the bot itself |
| `paper-trader:state:trades` (list) | **One record per closed trade**: entry and exit, stop, target, charges, result in R, best and worst point reached (`mfeR`, `maeR`), why it entered, the full entry checklist, the **confidence score**, the stock's daily trend, VIX, news verdict, the rules in force. | when a trade closes | `report.js`, `be-shadow.js` |
| `paper-trader:state:signals` (list) | **Every candle that broke an opening-range level, accepted or rejected**, with every condition (VWAP, volume, Nifty, chase), volume ratios, confidence, and what happened (`ENTERED` or `REJECTED` and why). | when the candle closes | `filters.js`, `strategies.js` |
| `paper-trader:state:days` (list) | **One record per trading day**: shortlist, why other stocks were rejected, every plan's final status and blocks (such as "stop level hit before breakout"), news verdicts with reasons and sources, stocks the news check removed (`shadow`), the day's event log, the settings used. | at the close | `shadow-news.js`, your own reading |
| `paper-trader:state:candles:<day>` | 1-minute prices for every stock the bot watched that day (about 25 stocks). | at the close | `strategies.js`, `be-shadow.js`, `filters.js` |
| `paper-trader:state:bars5m:<day>` | 5-minute prices for **all 200 stocks**, Nifty and India VIX (about 300 KB a day). The long-term archive. | after 15:38 | `lab.js`, research |
| `paper-trader:state:settings` | Your changes from the Settings screen. | when you save | the bot |
| `paper-trader:state:settings-log` (list) | When each setting changed, old and new value. | when you save | audit |

### 2.2 Swing portfolio

| Redis key | What it holds |
|---|---|
| `paper-trader:mbook:state` | Cash, holdings, prepared pick list, the value curve. |
| `paper-trader:mbook:trades` (list) | Every buy and sell with price, charges, rank and reason. |
| `paper-trader:mbook:days` (list) | One record per trading day: value, cash, Nifty close, holdings. |

### 2.3 Mover scanner

| Redis key | What it holds |
|---|---|
| `paper-trader:movers:state` | Today's scan and outcomes, days still waiting for outcomes. |
| `paper-trader:movers:scans` (list) | One record per mover per day: move and gap at 9:35, early volume against its own usual, news category, whether the news explains the move, the reason and the source headlines. |
| `paper-trader:movers:outcomes` (list) | One record per mover per day: what it did to 10:30, 12:00, 13:30, 15:15 and the close, signed in its own direction and minus Nifty, plus best and worst point. |

### 2.4 Download links (on the live site, https://paper-t.onrender.com)

`/api/export/trades.csv` or `.json`, `/api/export/signals.csv` or `.json`, `/api/export/days.json`, `/api/export/candles.json?day=YYYY-MM-DD`, `/api/export/bars5m.json?day=YYYY-MM-DD`, `/api/mbook`, `/api/mbook/trades.json`, `/api/movers`, `/api/movers/scans.json`, `/api/movers/outcomes.json`, `/api/settings/log`.

### 2.5 Local only (not in Redis, not on GitHub)

| Folder or file | What it is | How to recreate it |
|---|---|---|
| `data/fyers-5m/` | 24 months of 5-minute prices, 200 stocks plus Nifty and VIX (Oct 2024 to Oct 2026). | `node --env-file=.env fyers-login.js` (browser login, token lasts until about midnight), then `node --env-file=.env fyers-download.js --months 24 --res 5 --out data/fyers-5m --symbols data/universe.txt` |
| `data/fyers-daily-10y/` | 10 years of daily prices. | same, with `--res D --months 120 --out data/fyers-daily-10y` |
| `data/universe.txt` | The symbol list (Nifty, VIX, the 200 stocks). | written from `config.js` |
| `data/lab-cache/`, `data/ranking-*/`, `data/factor2-*.json`, `data/lab-results.json`, `data/movers-backfill.json` | Outputs of the research scripts. Safe to delete and regenerate. | run the script again |
| `data/news-cache/` | Cached Google News and Gemini answers for historical news checks. | automatic |
| `.env` | Upstash URL and token, Gemini key, Fyers app id, secret and redirect. **Never commit.** | |

### 2.6 How big can it get

About 400 KB per trading day (mostly the 5-minute archive), so about 100 MB a year against Upstash's free 256 MB. Check usage in the Upstash dashboard now and then. If it nears the limit, the oldest `bars5m:` and `candles:` keys can be exported and deleted.

---

## 3. What "good" has to beat: the baselines we already measured

These come from replays on past data (no live trading). A live result only means something if it is judged against these.

**Day-trading bot (ORB), 494 sessions, 3 Oct 2024 to 1 Oct 2026, current rules, no news filter, charges included**

| Measure | Value |
|---|---|
| Trades | 387 (about 0.78 per session) |
| Average per trade | **−0.08R** (R = the amount risked per trade) |
| Net over two years on ₹20,000 per day | **−₹2,101** (price moves +₹1,675, charges −₹3,776) |
| Win rate | 30% |
| Same stocks chosen at random | −0.15R (so the ranking helps) |
| Longs versus shorts | longs −0.17R, shorts +0.02R (a bear-market period) |
| Charges | about 0.14% of the traded value per round trip, about 0.13R per trade |

**The opening-range rules on ALL stocks (the big-sample test), 9,841 hypothetical trades, 494 sessions, no position limits**

| Measure | Value |
|---|---|
| Net per trade | **−0.166R** (win 26%) |
| Of which price moves (before charges) | **−0.026R**: the signal itself has no edge |
| Of which charges | −0.140R (about ₹26 per trade, 0.106% of the traded value) |
| If charges were halved | −0.096R. If zero: −0.026R. So a cheaper broker would not fix it. |
| Search for a selection rule (22 entry-time measurements, up to 2 conditions, searched on the first 12 months, tested on the last 12) | **none found**: best rules t ≤ 0.9, below the luck level (a shuffled-outcome control reached t 1.6), and none held up in the test half |
| Measurements that looked better in both halves | wider stops, wider opening range, higher volatility, relative strength, distance beyond VWAP. Mostly a cost effect: a wider stop means charges are a smaller share of the risk. None reached break-even. |

How it was made (rerun if the engine rules change): 8 chunks of `node --max-old-space-size=5000 ranking-test.js --name all_cN --shortlist 200 --from <date> --to <date> --set maxPositions=1000 --set maxTradesPerDay=1000 --set dailyLossPct=1000 --set leverage=1000`, then `node --max-old-space-size=6000 selector-study.js --glob "data/ranking-all_c*"`. Takes about 30 minutes on 8 cores. The stock ranking (top 6) is worth about +0.09R per trade over taking every stock (−0.08R versus −0.17R).

**Variants tested** (all one change at a time): last entry 10:00 / 11:30 / 14:30, breakeven 0.25R / 1R, target 1.5R / 3R, no Nifty filter, volume 0.75× / 1.2×, confidence gate 85, no trailing, longs only. **None was proven better.** The two least bad: volume 1.2× (−₹398) and confidence ≥ 85 (−₹719). Both are tracked live in `strategies.js`.

**Swing portfolio, 10 years of daily data (optimistic: today's Nifty 200 only)**: 21.8% a year, 33% worst drop, against Nifty 9.0%. Compared with simply holding the same stocks equally it was not proven better (+0.27% a month, error bars include zero).

**Mover scanner, 484 sessions, 9,095 movers**: on average they do **not** keep going: +0.02% from 9:35 to 15:15, 49% still going, −0.12% after charges. Only moves of 6% or more looked different: +0.44% (372 movers), +0.30% after charges. The median there is only +0.15%, 77% of the gain comes from the best 10 trades, and the universe flatters up-moves. With news checked (last 60 sessions): a news reason did not help (+0.05% with, −0.02% without).

**Confidence score** (calibrated on 1,906 replayed trades): the best fifth beat the worst fifth by +0.17R (t = 2.6), but that was checked on the same data it was set on, and no tier was profitable.

**Daily-trend ranking**: it beats random picks, but ranks 1 to 10 are equivalent and ranks 11 to 20 are clearly worse. A shortlist of 6 is reasonable.

---

## 4. How long until the data means anything (read this before judging)

**30 days is enough to check the machinery and spot disasters. It is not enough to prove an edge.** The size of the noise decides how much data you need:

| Question | Data needed | How long at today's pace |
|---|---|---|
| ORB: is the average per trade within ±0.38R of the truth? | about 24 trades | about 30 sessions |
| ORB: within ±0.21R? | about 80 trades | about 100 sessions (about 5 months) |
| ORB: within ±0.13R? | about 200 trades | about 250 sessions (about 1 year) |
| ORB: prove a real edge of +0.10R | about 370 trades | about 470 sessions (about 2 years) |
| Mover scanner: confirm the "6% or more" lead (+0.30% after charges) | about 550 such movers | about 700 trading days live. **Too slow. Use a longer historical backfill instead** (download 5 years of 5-minute data and rerun `movers-backfill.js`). |
| Swing portfolio | one decision a month, so 12 samples a year | cannot be judged by results for years. Judge it only by whether it follows its rules. |

So the live logs do three jobs: (1) show the pipeline works, (2) catch a strategy that is **clearly bad** (far below the baseline), and (3) build the dataset for the longer historical tests. Real conclusions come from historical replays with many more trades.

---

## 5. How to decide what is good (the test every idea must pass)

An idea is only "good" if **all** of these are true. If any fails, it is not proven.

1. **Positive after charges**, not just before. Charges are about 0.14% a round trip.
2. **Clearly different from zero**: the 95% margin of error excludes zero (roughly t ≥ 2; use t ≥ 2.5 when you looked at many variants).
3. **Holds in both halves of the data** (first half and second half, or year 1 and year 2), and ideally in both rising and falling markets.
4. **Beats a dumb alternative**: random picks, or just holding Nifty or the same stocks.
5. **Not carried by a handful of trades.** If the best 10 trades are most of the profit, it is a lottery, not an edge.
6. **Decided before looking**, or confirmed on data you did not use to find it. Anything found by searching through many variants must be confirmed on fresh data.

Red flags: a great number on fewer than 50 trades; a rule that changed after seeing results; survivorship (today's stock list); no stops modelled in a result that holds positions through big moves.

---

## 6. What to run, when, and what to look for

All commands run in the project folder. Add `--env-file=.env` so scripts can read Redis. Say "the dashboard" for https://paper-t.onrender.com.

### 6.1 Every day (30 seconds)
- Dashboard **Overview**: the status pill reads normal, no red error bar.
- **Today's plan**: news box says "Automatic news check applied" (or paste manually).
- After 15:50: **Swing** tab has a new day recorded; after 15:45: **Movers** tab outcomes filled in.
- Upstash dashboard, once a week: key count rising by about 4 to 6 per trading day, no storage warning.

### 6.2 Every week
- `node --env-file=.env report.js`: trades, win %, average R, profit factor, drawdown, long/short, hold time, per strategy version.
- Look at the **Trades** tab: does each trade's "why it triggered" checklist make sense?
- Write the numbers in the table in section 7.

### 6.3 At about 30 trading days (around mid November 2026)

| Check | Command or place | Healthy | Warning |
|---|---|---|---|
| Records are complete | Redis: `state:days` has one record per trading day since 5 Oct; `bars5m:` and `candles:` keys exist for each; `mbook:days` and `movers:scans` too | no missing trading days | gaps (the service slept or a job failed) |
| ORB basic numbers | `report.js --version 3.1` | about 20 to 30 trades, average per trade somewhere around the baseline −0.08R (very wide margin) | a clearly worse number such as −0.4R, or a losing streak beyond about 18 trades in a row (the worst in the two-year replay) |
| Do the filters earn their keep | `node --env-file=.env filters.js --until 10:30` | "rejected only by volume" does worse than "passed everything" | n under 30 per group means "too few", ignore |
| Shadow variants | `node --env-file=.env strategies.js` | read the volume 1.2× and confidence ≥ 85 rows against "V3 (live rules)" | any difference under 0.2R at this size is noise |
| Did the news check protect us | `node --env-file=.env shadow-news.js` | stocks it blocked did worse than the stocks it allowed | needs many blocked stocks; expect a small n |
| Confidence score | `report.js` prints trades, win % and average R for High, Medium and Low | High is not worse than Medium | too few trades to say anything yet |
| Swing portfolio | **Swing** tab and `/api/mbook` | the market switch matches Nifty versus about 24,340 (its 200-day average); if on, 10 holdings at about ₹5,000 each | holdings while the switch is off, or none while it is on |
| Mover scanner | **Movers** tab study table | 300 to 900 movers recorded; the "All movers" row near the backfill (about 0%) | "News check unverified or not run" large (the Gemini key is missing or failing) |

At 30 days the only possible **decisions** are: "the machinery works", "something is broken", or "something is clearly bad".

### 6.4 At about 100 trading days (around March 2027)
- ORB: about 80 trades. Re-run `report.js`, `filters.js`, `strategies.js`. If the live average per trade is still near −0.08R, the replay result holds: **no edge**. If it is above 0 with the margin of error (about ±0.2R) excluding zero and positive in both halves, that is the first real signal.
- Mover scanner: the study table has about 100 days. Check the "Move of 6% or more" row only as a sanity check against the backfill (+0.44%).
- Swing portfolio: about 5 monthly decisions. Check it matched its rules and compare its value with Nifty.

### 6.5 At about 250 trading days (around October 2027)
- ORB: about 200 trades, margin of error about ±0.13R. This is the first point where "clearly profitable" or "clearly not" can be said for the day-trading bot.
- Rerun the whole historical research on the larger dataset (section 8).

### 6.6 Any time: get faster answers from history
- Download more years of 5-minute prices (`fyers-download.js --months 60 --res 5 ...`) and rerun `ranking-test.js` and `movers-backfill.js`. More history gives far more power than waiting for live days.

---

## 7. Fill-in table (update at every checkpoint)

| Date | Sessions since 5 Oct | ORB trades | ORB avg R | ORB net ₹ | Swing value | Movers logged | Notes / decision |
|---|---|---|---|---|---|---|---|
| 6 Oct 2026 | 1 | 0 | – | – | ₹50,000 (cash, switch off) | starting | Everything just deployed. |
| | | | | | | | |

---

## 8. Research toolbox (what each script does)

| Script | What it answers | Needs |
|---|---|---|
| `report.js` | Overall live results of the day-trading bot per strategy version. | Redis |
| `filters.js` | Do the entry filters (volume, Nifty, chase) help? Replays rejected setups as if taken. | Redis |
| `strategies.js` | Which rule set is better, on the **same live signals** (the shadow variants live here). | Redis |
| `be-shadow.js` | Breakeven at +0.5R versus +1R on the logged trades. | Redis |
| `shadow-news.js` | Did the news check help? Replays the stocks it removed. | Redis |
| `ranking-test.js` and `sweep-report.js` | Runs the real engine over 24 months with different settings or random picks; compares variants. | local Fyers 5-minute data |
| `selector-study.js` | Does any combination of entry-time measurements pick winning trades? Searches rules on the first half of the sessions, tests on the second, with a shuffled-outcome luck control. | the hypothetical trades from `ranking-test.js --shortlist 200` (see section 3) |
| `lab.js`, `factors.js`, `factors2.js` | Candidate intraday strategies and "what predicts the move after 10:00" screens. | local data / Yahoo |
| `momentum-sim.js`, `swing-study.js`, `scan-m1.js` | The swing strategy over 10 years; today's pick list. | local daily data |
| `movers-backfill.js` | The mover study on 24 months of history (add `--news-days 60` for news). | local Fyers data, Gemini key for news |
| `npm test` | 41 automated checks of the code. Run before any change goes live. | nothing |

---

## 9. Known quirks in the data (so you do not misread it)

- **Day records for 2, 3 and 4 Oct 2026**: 2 Oct was a market holiday; 3 and 4 Oct were a weekend. A bug let the bot build plans and call the news service on those days. It is fixed from 5 Oct. Those three records show 0 trades and can be ignored. The 1 Oct record is version 2 rules.
- **Strategy versions**: 1 Oct = v2 (entries to 14:30), 2 to 4 Oct = v3 (to 10:00), from 5 Oct = **v3.1** (to 10:30). `report.js` separates them. Only v3.1 counts for the 30-day check.
- **Capital**: the day-trading bot's paper capital was ₹20,000 until you changed it to ₹50,000 on the Settings screen at 22:44 on 4 Oct. The swing portfolio is a separate ₹50,000.
- **The only trade so far** is PFC on 1 Oct (+₹138), logged before the detailed records existed, so it is in the bot's state but not in the `trades` list.
- **Empty `trades` and `signals` lists are normal** on quiet days. On 5 Oct every short setup died because price rose through its stop level first, which is recorded in that day's record (the `blocks` of each plan), not in `signals`. `signals` only holds candles that actually broke the level the right way.
- **Replay results exclude the news check** (it cannot be replayed exactly), use 5-minute bars turned into 1-minute bars, and use today's Nifty 200 list (survivorship).
- **The same stocks keep appearing** (SUZLON, PFC and so on) because the ranking rewards a long steady trend. That is by design. A bug that kept yesterday's price history was fixed on 5 Oct.
- **Fyers token** expires around midnight. Regenerate the Fyers secret you pasted into the chat earlier.

---

## 10. Decision log (what we learned and chose, newest last)

| Date | What happened |
|---|---|
| 1 Oct 2026 | Bot deployed on Render (live paper). News check was a manual ChatGPT paste. |
| 2 Oct | Automatic news check added (we fetch headlines, Gemini classifies; unverified is treated as unsafe). Entries cut to 10:00 (v3) after a 59-session test. |
| 5 Oct | Two-year replay (494 sessions) overturned the 59-session findings: no entry cutoff, breakeven, target or filter setting helped; the baseline loses about ₹2,100. Entries set to 10:30 at your request (v3.1). Stale-price-history bug fixed. Confidence score added. Swing portfolio started. |
| 6 Oct | Only short setups appeared (Nifty downtrend; SUZLON ranks first daily because the 20/50-day gap dominates the score). Tested on the 494 sessions with `ranking-test.js --rsilo 30 --rsihi 70 --trendcap 3`: baseline -0.078R/trade (net -2,101); RSI filter -0.080R (-2,573); trend-gap cap -0.111R (-3,055); both -0.124R (-3,315). None helped, so the ranking is unchanged. 8-year Fyers download (data/fyers-5m-long) is half done, 98 of 202 symbols; needs a new Fyers login to resume. |
| 6 Oct | F&O option selling looked at. Fyers gives a live Nifty option chain (bid/ask, OI, VIX) and 5-minute history for current contracts only; expired contracts are not available. `options-sim.js` models weekly iron condors with Black-Scholes and India VIX over 396 weeks (2018-2026), 1 lot of 65: 1-SD short strikes, 1% wings, hold to expiry: +₹86k, 78% wins, t=1.05, worst week -₹13.6k, max drawdown ₹50k (equal to the whole ₹50k capital). With a 1.5x-credit stop: +₹103k, drawdown ₹32k, t=1.41. 1.5-SD strikes: about zero. Not significant; modelled prices are optimistic. |
| 6 Oct | Swing book rerun with its live code (`momentum-sim.js`, 10-year daily data, today's Nifty 200 members so survivorship bias): ₹50,000 became ₹290,323 (2017-11 to 2026-10), 21.8%/yr vs Nifty 9.0%/yr, max drawdown 33%, 596 trades, charges ₹9,376. Development (to 2022) 17.2%/yr vs Nifty 11.2%; holdout (2023 on) 28.5%/yr vs 5.8%. Regime filter is OFF today (Nifty 22,488 below 200-day average 24,334), so the live book holds cash. |
| 6 Oct | v3.2: balanced shortlist (half long candidates, half short candidates; setting `balancedShortlist`, shortlist 12). Replay on 494 sessions: 12 stocks 601 trades, 28.8% wins, -0.119R, net -5,415 (longs 264 trades -0.181R; shorts 337 trades -0.070R); 6 stocks (3+3) 429 trades, -0.075R, net -2,506. Old rule (trend only, 6): 387 trades, -0.078R, net -2,101 (longs 201 trades -0.173R; shorts 186 trades +0.024R). Long entries lose in every version. Done for exploration, not because it works. |
| 6 Oct | Mover study on 8 years (data/fyers-5m-long, 200 stocks, 1,956 sessions, 33,070 movers of 2%+ at 09:35): 2-6% movers have no edge (all about -0.14% after charges); 5%+ n=3,136 +0.43% to close (+0.29% after charges, t=1.3); 6%+ n=1,815 on 754 days +0.62% (+0.48% after charges, t=1.4, first held to 15:15 with no stop). The 4-6% bucket is slightly negative, so the effect is only in the extreme tail and not significant. Next: check outliers and corporate-action artefacts before trusting it. |
| 6 Oct | Robustness check of the 6%+ lead (`movers-robust.js`): median only +0.21%; without the top 5% of winners the mean is -0.07%; no artefact from 15%+ moves (55 cases, they are even better). Edge sits in DOWN-moves (n=946, +1.20% held to 15:15) while up-moves are about zero (-0.01%); 2020 carries 395 of those down cases (+1.55%), ex-2020 down-moves are n=545 on 294 days, +0.89% (+0.75% after charges). Fixed stops (1-3%) do not help (median trade stopped out). Day-clustered t about 1.0-1.3, so NOT proven. Treated as a shadow study only: short 6%+ gap-down movers at 09:35, exit 15:15. |
| 6 Oct | "Momentum V5" tested in `intraday-lab.js` (three setups A opening 09:35-10:30, B pullback 10:30-13:30, C afternoon breakout 13:30-14:45; 0-100 score; stops 0.4-1.2%, 1.5R, charges 0.14%, parameters fixed before the run). 8 years, 528k signals: every setup loses in both development and holdout. At score 70+: A -0.111R, B -0.185R, C -0.130R per trade (t(day) -10 to -30). Higher score helps a little and consistently (A: -0.183R at 0 to -0.100R at 80+) but never reaches positive. Last 6 months (35k signals) gives the same picture. Gross edge about zero, charges (0.12-0.35R per trade at these stops) decide it. |
| 6 Oct | **All-stocks test**: ran the live rules on every stock (9,841 hypothetical trades). Net −0.166R; before charges −0.026R. No selection rule survived a first-half search and second-half test. Conclusion: the opening-range signal has no edge on its own; more samples do not change that, and a cheaper broker would not fix it. Remaining leads: very large opening moves (6% or more), and longer holds (swing). |
| 6 Oct | Mover scanner deployed. Mover backfill: movers do not keep going on average; the 6%+ pocket is a lead only. |

---

## 11. Maintenance rule (for you and for Claude)

Whenever we **add stored data, a study, a script, or change the rules version**, update this file in the same change:
- section 2 (what is stored and where),
- section 3 (baselines, if new ones were measured),
- section 6 (what to run and what to look for),
- section 7 (add a row at each checkpoint),
- section 10 (one line in the decision log).

If this file and the code ever disagree, the code is right: fix this file.
