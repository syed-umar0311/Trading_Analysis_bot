// EXTRA INDICATORS computed on demand from stored candles + engine output.
const config = require('../config');
const logger = require('../utils/logger');
const { Candle, StructureState, LiquidityZone, SymbolStats } = require('../models');
const { premiumDiscount } = require('../engine/premiumDiscount');
const { computeCvd } = require('../engine/cvd');
const { volumeProfile } = require('../engine/volumeProfile');
const { latestSessionLevels } = require('../engine/sessions');
const orderBook = require('./orderBookService');

async function getIndicators(symbol, tf, { includeOrderBook = true, candleCount = 300 } = {}) {
  const scope = { exchange: config.exchange, symbol, timeframe: tf };
  const [rows, state, eqZones, stats] = await Promise.all([
    Candle.find(scope).sort({ openTime: -1 }).limit(candleCount).lean(),
    StructureState.findOne(scope).lean(),
    LiquidityZone.find({ ...scope, type: { $in: ['EQUAL_HIGH', 'EQUAL_LOW'] }, status: 'RESTING' }).sort({ level: 1 }).lean(),
    SymbolStats.findOne({ exchange: config.exchange, symbol }).lean(),
  ]);
  rows.reverse();
  const price = stats?.markPrice || state?.lastPrice;

  const pd = state ? premiumDiscount({ swingHigh: state.lastSwingHigh?.price, swingLow: state.lastSwingLow?.price, price, bias: state.bias }) : null;
  const cvd = computeCvd(rows);
  const vp = volumeProfile(rows);

  let book = null;
  if (includeOrderBook) {
    try { book = await orderBook.getImbalance(symbol); } catch (err) { logger.warn(`order book ${symbol}:`, err.message); }
  }

  return {
    symbol,
    timeframe: tf,
    atr: state?.atr ?? null,
    atrPctOfPrice: state?.atr && price ? Number(((state.atr / price) * 100).toFixed(3)) : null,
    premiumDiscount: pd,
    equalLevels: {
      highs: eqZones.filter((z) => z.side === 'HIGH').map((z) => ({ level: z.level, touches: z.strength })),
      lows: eqZones.filter((z) => z.side === 'LOW').map((z) => ({ level: z.level, touches: z.strength })),
    },
    cvd: { total: cvd.total, trend: cvd.trend, divergence: cvd.divergence, recent: cvd.series.slice(-30) },
    volumeProfile: vp ? { poc: vp.poc, valueAreaHigh: vp.valueAreaHigh, valueAreaLow: vp.valueAreaLow, rangeHigh: vp.rangeHigh, rangeLow: vp.rangeLow, candlesUsed: rows.length } : null,
    sessions: latestSessionLevels(rows, config.sessions),
    openInterest: stats ? { value: stats.openInterest, usd: stats.openInterestUsd, changePct: stats.oiChangePct } : null,
    longShortRatio: stats?.longShort || null,
    orderBook: book,
  };
}

module.exports = { getIndicators };
