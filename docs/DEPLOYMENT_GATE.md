# Deployment gate: when a strategy may be considered for real capital

LOCKED 22 Oct 2026, before any strategy was judged against it. Thresholds change only with a dated note at the bottom of this file, never to make a strategy pass. Code: `lib/deploygate.js` (tested in `test/deploygate.test.js`). Report: `node --env-file=.env cycle-report.js` prints the end-of-cycle decision block and the disposition of every book.

Passing the gate makes a strategy ELIGIBLE FOR A SEPARATELY AUTHORISED, LIMITED-RISK LIVE TRIAL. It does not place or authorise an order.

## Acceptance criteria (all mandatory)
R = profit or loss divided by the amount risked at the stop.
| ID | Requirement | Threshold |
|---|---|---|
| G0 | Historical out-of-sample evidence of the exact rules | At least 200 trades over at least 2 years, positive average R after charges in BOTH the development and the holdout part |
| G1 | Forward expectancy | At least 100 forward trades; average R after charges AND the cautious stop-slippage estimate (stop-outs costed 0.25R worse) at least +0.10; day-clustered t at least 2 |
| G2 | Stability over time | Both chronological halves positive; at least 4 calendar weeks, at least 60% of them positive |
| G3 | Sample and regimes | At least 100 trades on at least 40 trading days, with at least 5 up and 5 down days (Nifty beyond +-0.3%) |
| G4 | Drawdown and losing streaks | Maximum drawdown at most 10R and longest losing streak at most 8 trades, observed |
| G5 | Cost sensitivity | Still positive with charges 50% higher (the slippage estimate is already in G1). Also required, once a replay exists: positive with a one-candle-delayed entry and with missed fills |
| G6 | Not a lottery | Best 10 trades at most 50% of the gross profit; no single stock more than 25% of it |
| G7 | No look-ahead, leakage or selection bias | Rules frozen (version-tagged) before the evaluation window and reviewed; recorded in the attestation |
| G8 | Paper/shadow consistent with the tested assumptions | Live results lie within the interval of a positive G0 test; recorded in the attestation |

## Disposition rules (fixed)
- G0 FAIL on a large sample: REJECT STRATEGY. A short live record cannot overturn a large negative out-of-sample test.
- Any other criterion not PASS: KEEP IN PAPER (or SHADOW), with the exact missing items listed.
- All PASS: DEPLOYMENT GATE PASSED.
- Data, execution or risk-control failure: HALT SYSTEM. No setup today: NO TRADE TODAY.
- Forward data stops mattering once the decision is made: a REJECT strategy is not given further chances by collecting more of the same data. It can only come back with a new, pre-registered hypothesis and an independent evaluation period.

## Risk limits required before any live trial (NOT configured; the system must not run live without them)
Today none of these exist for real capital: the paper-trader has no order code, no real capital or broker-permission setting, and collect-everything mode switches the position cap, the trade cap, the loss halt and the buying-power check off. Before a live trial the owner must supply, in verified configuration, and the code must enforce:
- Verified available capital and account permissions (from broker data or signed configuration; never assumed).
- Approved risk fraction per trade; maximum loss per trade (stop distance plus costs and an execution allowance); shares = floor(capital x risk fraction / estimated loss per share).
- Maximum aggregate open risk; maximum daily realised plus unrealised loss; maximum number of entries; a limit on correlated positions; a halt on data failure or stale quotes; a manual kill switch.
- For derivatives: actual lot sizes, margin requirements, and instrument-specific worst-case loss.

## Real execution stage (does not exist yet; starts only after a passed gate AND your explicit authorisation)
Verify the broker API, order types, exchange eligibility and regulatory requirements; use broker-confirmed order state as the source of truth; handle rejected, partially filled, duplicated and uncertain orders with a predefined recovery procedure that prevents duplicate exposure; protective exits placed and confirmed; end-of-day reconciliation. A human approves every live order at first. Live trading is never enabled silently, capital exposure is never raised silently, and no safety control is ever disabled silently.

## Dispositions issued 22 Oct 2026 (from `cycle-report.js`)
| Strategy | Disposition | Why |
|---|---|---|
| Momentum V5 | REJECT STRATEGY | G0 fails: 8 years, 528k signals, every setup negative after charges in development and holdout (best case -0.111R, t(day) -10 to -30). Live 41 trades: -0.06R, t 0.32; also fails G1, G2, G3, G5, G6. Caveat: the live ranking/news layer is not replayed historically; live data could in principle differ, but the gate does not let 41 trades override 528k |
| Day bot (opening-range breakout) | REJECT STRATEGY | G0 fails: 494 sessions, 387 trades -0.08R; 9,841 hypothetical trades -0.166R with price moves alone -0.026R; no selection rule found. Live 6 trades -0.78R |
| ISS short straddle | KEEP IN PAPER | Model-only history (clock-dependent); 3 forward trades, all net negative (-1,126 Rs). Needs at least 30 forward trades on real quotes |
| F&O iron condor | KEEP IN PAPER | 1 trade; needs at least 30 expiries |
| Swing portfolio | KEEP IN PAPER | One decision a month; survivorship in the history; cannot be judged by results for years |
| ML models | REJECT (research models); KEEP IN SHADOW (frozen baseline) | EXP-B-001 failed (-13.7 to -14.7 bps net per trade); the shadow forward gate (docs/SHADOW.md) has not started because the service has not been running |
Cycle outcome: NO TRADE TODAY. No strategy is eligible for real capital.

## Change log
- 22 Oct 2026: gate locked; dispositions issued.
