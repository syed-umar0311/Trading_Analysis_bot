// External liquidity levels that don't come from a timeframe's own swings:
//  - Previous Day High / Low (from the daily candle, via statsService)
//  - Asian / London / New York session highs & lows (from stored intraday candles)
const config = require('../config');
const logger = require('../utils/logger');
const { TF_MS, sortTimeframes } = require('../utils/timeframes');
const { Candle } = require('../models');
const { latestSessionLevels, sessionZoneSpecs } = require('../engine/sessions');
const runner = require('./engineRunner');

const DAY = 24 * 3_600_000;
let timer = null;

// PDH/PDL become live liquidity from the start of the NEXT UTC day.
async function injectPreviousDay(symbol, stats) {
  if (!stats.pdh || !stats.pdl || !stats.pdDayOpenTime) return;
  const activeFrom = stats.pdDayOpenTime + DAY;
  await runner.injectExternalZones(symbol, [
    { key: `PDH:${stats.pdDayOpenTime}`, type: 'PDH', side: 'HIGH', level: stats.pdh, label: 'Previous day high', activeFrom },
    { key: `PDL:${stats.pdDayOpenTime}`, type: 'PDL', side: 'LOW', level: stats.pdl, label: 'Previous day low', activeFrom },
  ]);
}

// Sessions need an intraday timeframe (<= 1h) to be accurate.
async function injectSessions(symbol) {
  const base = sortTimeframes(config.timeframes).find((tf) => TF_MS[tf] <= 3_600_000);
  if (!base) return;
  const since = Date.now() - 3 * DAY;
  const candles = await Candle.find({ exchange: config.exchange, symbol, timeframe: base, openTime: { $gte: since } }).sort({ openTime: 1 }).lean();
  const specs = sessionZoneSpecs(latestSessionLevels(candles, config.sessions));
  if (specs.length) await runner.injectExternalZones(symbol, specs);
}

async function refreshSymbol(symbol) {
  await injectSessions(symbol);
}

function startPolling(getSymbols) {
  timer = setInterval(async () => {
    for (const s of getSymbols()) await refreshSymbol(s).catch((e) => logger.warn(`sessions ${s}:`, e.message));
  }, config.stats.sessionRefreshMs);
}
function stopPolling() { if (timer) clearInterval(timer); }

module.exports = { injectPreviousDay, injectSessions, refreshSymbol, startPolling, stopPolling };
