// All settings can be overridden with environment variables, e.g.  CAPITAL=50000 LEVERAGE=5 npm start
const num = (k, d) => (process.env[k] !== undefined && !isNaN(+process.env[k]) ? +process.env[k] : d);

module.exports = {
  // live   = real prices right now (only trades 9:15-15:30 IST on market days)
  // replay = re-plays a real, recent trading day (works any time, even weekends)
  // demo   = made-up prices, needs no internet (for testing)
  mode: process.env.MODE || 'replay',
  replayDay: process.env.DAY || null,      // YYYY-MM-DD, must be within the last ~7 days. Default: latest full session
  speed: num('SPEED', 60),                 // replay speed: 60 = one market minute per real second
  port: num('PORT', 3000),

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
  shortlistSize: num('SHORTLIST', 6),
  minAtrPct: 1.0,                          // need enough daily movement to be worth trading
  maxAtrPct: 4.5,
  minTurnover: 3e8,                        // avg daily traded value (INR) for liquidity
  allowShort: process.env.ALLOW_SHORT !== '0',

  // ---- entries ----
  orMinutes: 15,                           // opening range = first 15 minutes
  triggerBufferPct: 0.05,                  // enter a little beyond the range edge
  minOrPct: 0.3, maxOrPct: 2.5,            // skip days where the opening range is too tight or too wide
  minVolRatio: 0.9,                        // breakout candle volume vs day's average 5-min volume
  maxChasePct: 0.4,                        // do not buy if price already ran this far past the trigger
  useIndexFilter: process.env.INDEX_FILTER !== '0',
  lastEntryMin: 14 * 60 + 30,              // no new trades after 14:30
  squareOffMin: 15 * 60 + 15,              // everything closed by 15:15

  // ---- risk ----
  riskPct: num('RISK_PCT', 1),             // % of equity risked per trade (distance to stop x quantity)
  maxAllocPct: num('MAX_ALLOC', 50),       // max % of equity (x leverage) in one stock
  maxPositions: num('MAX_POS', 3),
  maxTradesPerDay: num('MAX_TRADES', 6),
  dailyLossPct: num('DAILY_LOSS', 3),      // stop trading for the day at this loss
  rr: num('RR', 2),                        // target = rr x risk
  minStopPct: 0.4, maxStopPct: 1.2,        // stop distance limits as % of price
  trailing: process.env.TRAILING !== '0',  // move stop to breakeven at +1R, then trail at +1.5R
  slippagePct: 0.02,                       // assumed slippage on market-type fills

  // ---- market context ----
  vixSymbol: '^INDIAVIX', vixElevated: num('VIX_ELEVATED', 18), vixHigh: num('VIX_HIGH', 24), // risk is cut to 75% / 50%
  // News screen (Gemini + Google Search). Needs GEMINI_API_KEY. Live mode only, because a replay of a past day
  // would be contaminated by news that already knows how that day ended.
  newsGuard: !!process.env.GEMINI_API_KEY && process.env.NEWS_GUARD !== '0' && ((process.env.MODE || 'replay') === 'live' || process.env.NEWS_IN_REPLAY === '1'),
  newsRequired: process.env.NEWS_REQUIRED === '1',   // 1 = do not trade at all if the news check fails
  newsRetryMs: num('NEWS_RETRY_MS', 30000)
};
