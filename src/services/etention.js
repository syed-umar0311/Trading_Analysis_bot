const config = require('../config');
const logger = require('../utils/logger');
const { TF_MS } = require('../utils/timeframes');
const { Candle, LiquidityZone, Fvg, OrderBlock, StructureEvent, Swing } = require('../models');

const KEEP_CANDLES = 5000; // per timeframe

async function prune() {
  const now = Date.now();
  for (const tf of config.timeframes) {
    const cutoff = now - KEEP_CANDLES * TF_MS[tf];
    const r = await Candle.deleteMany({ timeframe: tf, openTime: { $lt: cutoff } });
    await Promise.all([
      LiquidityZone.deleteMany({ timeframe: tf, status: { $ne: 'RESTING' }, createdAt: { $lt: cutoff } }),
      Fvg.deleteMany({ timeframe: tf, status: 'FILLED', createdAt: { $lt: cutoff } }),
      OrderBlock.deleteMany({ timeframe: tf, status: 'MITIGATED', createdAt: { $lt: cutoff } }),
      StructureEvent.deleteMany({ timeframe: tf, time: { $lt: cutoff } }),
      Swing.deleteMany({ timeframe: tf, openTime: { $lt: cutoff } }),
    ]);
    logger.info(`retention ${tf}: removed ${r.deletedCount} old candles`);
  }
}

function start() {
  prune().catch((e) => logger.warn('retention failed', e.message));
  setInterval(() => prune().catch((e) => logger.warn('retention failed', e.message)), 24 * 3600 * 1000);
}
module.exports = { start };