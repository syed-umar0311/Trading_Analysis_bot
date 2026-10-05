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

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 4000),
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/liquidity_bias',
  corsOrigin: process.env.CORS_ORIGIN || '*',

  exchange: 'binance',
  binance: {
    restUrl: process.env.BINANCE_REST_URL || 'https://fapi.binance.com',
    wsUrl: process.env.BINANCE_WS_URL || 'wss://fstream.binance.com/market',
    wsMaxStreamsPerConnection: num(process.env.WS_MAX_STREAMS, 100),
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
