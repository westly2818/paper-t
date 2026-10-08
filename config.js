// All settings can be overridden with environment variables, e.g.  CAPITAL=50000 LEVERAGE=5 npm start
const hm = (k, d) => { const m = /^(\d{1,2}):(\d{2})$/.exec(process.env[k] || ''); return m ? +m[1] * 60 + +m[2] : d; };
const num = (k, d) => (process.env[k] !== undefined && !isNaN(+process.env[k]) ? +process.env[k] : d);

module.exports = {
  // live   = real prices right now (only trades 9:15-15:30 IST on market days)
  // replay = re-plays a real, recent trading day (works any time, even weekends)
  // demo   = made-up prices, needs no internet (for testing)
  strategyVersion: process.env.STRATEGY_VERSION || '3.3', // bump when you change rules, so later analysis can compare versions
  mode: process.env.MODE || 'replay',
  replayDay: process.env.DAY || null,      // YYYY-MM-DD, must be within the last ~7 days. Default: latest full session
  speed: num('SPEED', 60),                 // replay speed: 60 = one market minute per real second
  port: num('PORT', 3000),
  // Live mode saves its state so open trades survive a restart. Preferred: free Upstash Redis
  // (set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN), works on Render's free plan.
  // Fallback: a local file (STATE_FILE), which Render's free plan wipes on restart.
  upstashUrl: (process.env.MODE || 'replay') === 'live' ? process.env.UPSTASH_REDIS_REST_URL || null : null,
  upstashToken: process.env.UPSTASH_REDIS_REST_TOKEN || null,
  stateKey: process.env.STATE_KEY || 'paper-trader:state',
  stateFile: (process.env.MODE || 'replay') === 'live' && !process.env.UPSTASH_REDIS_REST_URL ? (process.env.STATE_FILE || require('path').join(__dirname, 'data', 'state.json')) : null,

  capital: num('CAPITAL', 20000),          // starting virtual cash (INR)
  leverage: num('LEVERAGE', 1),            // 1 = no leverage. Indian brokers give ~5x intraday (MIS) on many stocks

  // ---- stock selection (morning plan) ----
  // NIFTY 200 constituents (NSE symbols), from archives.nseindia.com/content/indices/ind_nifty200list.csv
  watchlist: [
    '360ONE','ABB','APLAPOLLO','AUBANK','ADANIENSOL','ADANIENT','ADANIGREEN','ADANIPORTS','ADANIPOWER',
    'ATGL','ABCAPITAL','AMBUJACEM','APARINDS','APOLLOHOSP','ASHOKLEY','ASIANPAINT','ASTRAL','AUROPHARMA',
    'DMART','AXISBANK','BSE','BAJAJ-AUTO','BAJFINANCE','BAJAJFINSV','BAJAJHLDNG','BANKBARODA','BANKINDIA',
    'MAHABANK','BDL','BEL','BHARATFORG','BHEL','BPCL','BHARTIARTL','GROWW','BIOCON','BLUESTARCO','BOSCHLTD',
    'BRITANNIA','CGPOWER','CANBK','CHOLAFIN','CIPLA','COALINDIA','COCHINSHIP','COFORGE','COLPAL','CONCOR',
    'CUMMINSIND','DLF','DABUR','DIVISLAB','DIXON','DRREDDY','EICHERMOT','ETERNAL','EXIDEIND','NYKAA',
    'FEDERALBNK','FORTIS','GAIL','GVT&D','GMRAIRPORT','GLENMARK','GODFRYPHLP','GODREJCP','GODREJPROP',
    'GRASIM','HCLTECH','HDFCAMC','HDFCBANK','HDFCLIFE','HAVELLS','HEROMOTOCO','HINDALCO','HAL','HINDCOPPER',
    'HINDPETRO','HINDUNILVR','HINDZINC','POWERINDIA','HYUNDAI','ICICIBANK','ICICIGI','ICICIAMC','IDFCFIRSTB',
    'ITC','INDIANB','INDHOTEL','IOC','IRCTC','IRFC','IREDA','INDUSTOWER','INDUSINDBK','NAUKRI','INFY',
    'INDIGO','JSWENERGY','JSWSTEEL','JINDALSTEL','JIOFIN','JUBLFOOD','KEI','KALYANKJIL','KOTAKBANK','LTF',
    'LGEINDIA','LICHSGFIN','LTM','LT','LAURUSLABS','LENSKART','LICI','LODHA','LUPIN','MRF','M&MFIN','M&M',
    'MANKIND','MARICO','MARUTI','MFSL','MAXHEALTH','MAZDOCK','MEESHO','MOTILALOFS','MPHASIS','MCX',
    'MUTHOOTFIN','NHPC','NLCINDIA','NMDC','NTPC','NATIONALUM','NESTLEIND','OBEROIRLTY','ONGC','OIL','PAYTM',
    'OFSS','POLICYBZR','PIIND','PAGEIND','PATANJALI','PERSISTENT','PHOENIXLTD','PIDILITIND','POLYCAB','PFC',
    'POWERGRID','PREMIERENE','PRESTIGE','PNB','RECLTD','RADICO','RVNL','RELIANCE','SBICARD','SBILIFE','SRF',
    'MOTHERSON','SHRIRAMFIN','ENRIN','SIEMENS','SOLARINDS','SBIN','SAIL','SUNPHARMA','SUPREMEIND','SUZLON',
    'SWIGGY','TVSMOTOR','TATACAP','TATACOMM','TCS','TATACONSUM','TMCV','TMPV','TATAPOWER','TATASTEEL',
    'TECHM','TITAN','TORNTPHARM','TRENT','TIINDIA','UPL','ULTRACEMCO','UNIONBANK','UNITDSPR','VBL','VAML',
    'VEDL','VMM','IDEA','VOLTAS','WAAREEENER','WIPRO','YESBANK','ZYDUSLIFE'
  ],
  indexSymbol: '^NSEI',                    // Nifty 50, used as a market filter
  shortlistSize: num('SHORTLIST', 12),
  balancedShortlist: process.env.BALANCED_SHORTLIST !== '0', // half the shortlist from the best long candidates, half from the best short candidates (a market-wide downtrend then still shows longs)
  backupPoolSize: num('BACKUPS', 15),       // deep bench to replace a stock whose setup dies with no trade
  replaceUntilMin: hm('REPLACE_UNTIL', 10 * 60 + 30), // no backup is tried for a dead slot after this time (HH:MM IST); equal to lastEntryMin, a later backup can never enter
  replaceCandidates: num('REPLACE_CANDIDATES', 3), // backups queued per dead slot, all checked with one pasted reply
  minAtrPct: 1.0,                          // need enough daily movement to be worth trading
  maxAtrPct: 4.5,
  minTurnover: 3e8,                        // avg daily traded value (INR) for liquidity
  allowShort: process.env.ALLOW_SHORT !== '0',

  // ---- entries ----
  orMinutes: 15,                           // opening range = first 15 minutes
  triggerBufferPct: 0.05,                  // enter a little beyond the range edge
  minOrPct: 0.3, maxOrPct: 2.5,            // skip days where the opening range is too tight or too wide
  minVolRatio: num('MIN_VOL_RATIO', 0.9),                        // breakout candle volume vs the average of today's closed 5-min candles so far (opening-range candles and the breakout candle included)
  maxChasePct: 0.4,                        // do not buy if price already ran this far past the trigger
  useIndexFilter: process.env.INDEX_FILTER !== '0',
  lastEntryMin: hm('LAST_ENTRY', 10 * 60 + 30),               // version 3.1: no new trades after 10:30 (version 3 was 10:00, version 2 was 14:30)
  squareOffMin: hm('SQUARE_OFF', 15 * 60 + 15),              // everything closed by 15:15

  // ---- risk ----
  riskPct: num('RISK_PCT', 1),             // MAX % of equity risked per trade; quantity = min(risk / stop distance, allocation cap / price), so the cap often makes real risk lower
  maxAllocPct: num('MAX_ALLOC', 50),       // max % of equity (x leverage) in one stock
  maxPositions: num('MAX_POS', 3),
  maxTradesPerDay: num('MAX_TRADES', 6),
  dailyLossPct: num('DAILY_LOSS', 3),      // stop trading for the day at this loss
  rr: num('RR', 2),                        // target = rr x risk
  minStopPct: 0.4, maxStopPct: 1.2,        // stop distance limits as % of price
  breakevenR: num('BREAKEVEN_R', 0.5),         // move the stop to breakeven once the trade is this many R in profit
  trailing: process.env.TRAILING !== '0',  // breakeven at breakevenR; at +1.5R the stop trails 1R behind the best price
  slippagePct: 0.02,                       // assumed slippage on market-type fills

  // ---- market context ----
  // version 3.3: Gemini's market call "elevated" no longer cuts size (126-session test: elevated days were no more volatile than normal days, and it fired on 83% of days). "high" still cuts to 50% with 2 positions; an unverified call still cuts to 75%. Set ELEVATED_MARKET_CUT=1 (or the Settings screen) to bring the old 75% cut back.
  elevatedMarketCutsRisk: process.env.ELEVATED_MARKET_CUT === '1',
  vixSymbol: '^INDIAVIX', vixElevated: num('VIX_ELEVATED', 18), vixHigh: num('VIX_HIGH', 24), // risk is cut to 75% / 50%
  // Manual news screen: no API, no key. The dashboard shows a prompt to paste into ChatGPT (or
  // any AI) each morning; you paste its true/false reply back and the bot applies it. Live mode
  // only by default, because a replay of a past day would be contaminated by news that already
  // knows how that day ended.
  newsGuard: process.env.NEWS_GUARD !== '0' && ((process.env.MODE || 'replay') === 'live' || process.env.NEWS_IN_REPLAY === '1'),
  // Automatic news check (Gemini classifies headlines we fetch). Needs GEMINI_API_KEY (or LLM_API_KEY_FREE) in the environment.
  newsAuto: !!(process.env.GEMINI_API_KEY || process.env.LLM_API_KEY_FREE),
  unverifiedPolicy: 'block',                // a stock the news check could not verify: 'block' (default, never assume safe) or 'allow'
  newsWindowHours: 36,                      // only headlines newer than this are used
  geminiModel: 'gemini-3.1-flash-lite',
  // Momentum book: a separate paper-only monthly momentum portfolio (lib/momentum.js). Never touches the opening-range engine.
  moversEnabled: (process.env.MODE || 'replay') === 'live', // mover scanner: a study that never trades (lib/movers.js)
  mbookEnabled: (process.env.MODE || 'replay') === 'live',
  mbookCapital: 50000,                      // paper capital, fixed when the book is first created
  mbookSlots: 10,                           // number of stocks held
  mbookRebalanceMin: 10 * 60 + 30,          // monthly decision time, IST (any time up to 15:00 on the first trading day)
  newsRequired: process.env.NEWS_REQUIRED === '1',  // 1 = trading waits until the check is pasted in; the "Skip" button is hidden

  // ---- Momentum Strategy V5 ----
  v5Enabled: process.env.V5_ENABLED !== '0' && ((process.env.MODE || 'replay') === 'live' || process.env.V5_FORCE === '1'),
  v5Capital: num('V5_CAPITAL', 50000),
  fnoEnabled: process.env.FNO_ENABLED !== '0' && ((process.env.MODE || 'replay') === 'live' || process.env.FNO_FORCE === '1'),   // F&O paper book (lib/fno.js)
  fnoCapital: num('FNO_CAPITAL', 50000),
  fnoLot: num('FNO_LOT', 65),                // NIFTY lot size: check the current NSE value
  fnoMaxRiskPct: num('FNO_MAX_RISK', 25),    // worst-case loss of one condor as a % of the F&O capital
  v5MinScore: num('V5_MIN_SCORE', 60),
  v5Slots: num('V5_SLOTS', 12),
  v5MaxPositions: num('V5_MAX_POS', 3),
  v5MaxTrades: num('V5_MAX_TRADES', 6),
  v5RR: num('V5_RR', 1.5)
};
