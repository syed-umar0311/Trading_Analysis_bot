// Single place for every setting. Everything comes from .env so nothing is hard-coded elsewhere.
require('dotenv').config();
const { TF_MS } = require('../utils/timeframes');

const list = (v, d) => (v === undefined || v === '' ? d : v).split(',').map((s) => s.trim()).filter(Boolean);
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes'].includes(String(v).toLowerCase()));

const timeframes = list(process.env.TIMEFRAMES, '15m');
for (const tf of timeframes) {
  if (!TF_MS[tf]) throw new Error(`Unsupported timeframe "${tf}". Allowed: ${Object.keys(TF_MS).join(', ')}`);
}
const primaryTimeframe = process.env.PRIMARY_TIMEFRAME || timeframes[0];
if (!timeframes.includes(primaryTimeframe)) {
  throw new Error(`PRIMARY_TIMEFRAME ${primaryTimeframe} must be one of TIMEFRAMES (${timeframes.join(',')})`);
}

// ---------- Exchanges ----------
// EXCHANGES=binance,bybit  -> every coin is analysed on the COMBINED data of both venues.
// EXCHANGES=binance        -> exactly the old single-exchange behaviour (same for bybit alone).
const SUPPORTED_EXCHANGES = ['binance', 'bybit'];
const exchanges = [...new Set(list(process.env.EXCHANGES, 'binance,bybit').map((s) => s.toLowerCase()))];
for (const name of exchanges) {
  if (!SUPPORTED_EXCHANGES.includes(name)) throw new Error(`Unsupported exchange "${name}". Allowed: ${SUPPORTED_EXCHANGES.join(', ')}`);
}
if (!exchanges.length) throw new Error('EXCHANGES must list at least one exchange');
const primaryExchange = (process.env.PRIMARY_EXCHANGE || exchanges[0]).toLowerCase();
if (!exchanges.includes(primaryExchange)) {
  throw new Error(`PRIMARY_EXCHANGE ${primaryExchange} must be one of EXCHANGES (${exchanges.join(',')})`);
}

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 4000),
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/liquidity_bias',
  corsOrigin: process.env.CORS_ORIGIN || '*',

  // `exchange` is the scope key every derived collection (structure, zones, setups, stats, candles used by the
  // engine) is stored under: 'combined' when several venues are merged, otherwise the single venue's name.
  exchange: exchanges.length > 1 ? 'combined' : exchanges[0],
  exchanges, // enabled venues (raw candles are stored per venue under their own name)
  primaryExchange, // reference venue for the price-deviation guard and tie-breaks
  binance: {
    restUrl: process.env.BINANCE_REST_URL || 'https://fapi.binance.com',
    wsUrl: process.env.BINANCE_WS_URL || 'wss://fstream.binance.com/market',
    wsMaxStreamsPerConnection: num(process.env.WS_MAX_STREAMS, 100),
  },

  bybit: {
    restUrl: process.env.BYBIT_REST_URL || 'https://api.bybit.com',
    // USDT/USDC perpetuals + USDT futures. Use stream.bybit.<tld> if your account is registered on a regional domain.
    wsUrl: process.env.BYBIT_WS_URL || 'wss://stream.bybit.com/v5/public/linear',
    wsMaxStreamsPerConnection: num(process.env.BYBIT_WS_MAX_STREAMS, 100),
    wsPingMs: num(process.env.BYBIT_WS_PING_MS, 20000), // Bybit recommends a ping every 20 s
    category: 'linear',
  },

  // How the venues are merged into one candle stream.
  merge: {
    graceMs: num(process.env.MERGE_GRACE_MS, 5000), // wait this long for the slower venue before merging without it
    maxVenueDeviationPct: num(process.env.MAX_VENUE_DEVIATION_PCT, 5), // a venue whose close differs more than this is ignored for that candle
    requireAllVenues: bool(process.env.REQUIRE_ALL_EXCHANGES, false), // true = watchlist only accepts coins listed on every venue
  },

  defaultSymbols: list(process.env.DEFAULT_SYMBOLS, 'BTCUSDT,ETHUSDT,SOLUSDT').map((s) => s.toUpperCase()),
  timeframes,
  primaryTimeframe,
  backfillCandles: num(process.env.BACKFILL_CANDLES, 500),

  engine: {
    swingN: num(process.env.SWING_N, 2),
    minSwingMoveAtr: num(process.env.MIN_SWING_MOVE_ATR, 0),
    atrPeriod: num(process.env.ATR_PERIOD, 14),
    fvgMinAtr: num(process.env.FVG_MIN_ATR, 0),
    impulseAtr: num(process.env.IMPULSE_ATR, 1.5),
    obLookback: num(process.env.OB_LOOKBACK, 6),
    equalTolAtr: num(process.env.EQUAL_TOL_ATR, 0.1),
    rangingAfterCandles: num(process.env.RANGING_AFTER_CANDLES, 100),
    windowSize: 400, // how many recent candles each engine keeps in memory
    pruneAfterCandles: 300, // finished zones/FVGs/OBs older than this leave memory (they stay in MongoDB)
  },

  setup: {
    requireSweep: bool(process.env.SETUP_REQUIRE_SWEEP, true),
    slBufferAtr: num(process.env.SETUP_SL_BUFFER_ATR, 0.25),
    confluenceAtr: num(process.env.SETUP_CONFLUENCE_ATR, 1),
    reclaimMaxCandles: num(process.env.SETUP_RECLAIM_MAX_CANDLES, 60),
    minTargetGapAtr: 0.5, // a take-profit must be at least this far (in ATR) beyond entry
    dedupeLevelsAtr: 0.25, // targets closer than this are treated as the same level
  },

  // Session windows in UTC hours [start, end)
  sessions: {
    ASIA: { start: 0, end: 8 },
    LONDON: { start: 7, end: 16 },
    NEW_YORK: { start: 13, end: 22 },
  },

  stats: { pollMs: num(process.env.STATS_POLL_MS, 60000), sessionRefreshMs: 5 * 60 * 1000 },
  orderBook: { depthLimit: 500, bandPct: 0.5, cacheMs: 5000 },

  alerts: {
    enabled: bool(process.env.ALERTS_ENABLED, false),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    sweepLookbackCandles: 10, // CHoCH counts as "sweep + CHoCH" if a sweep happened this recently
  },
};
