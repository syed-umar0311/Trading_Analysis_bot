// One function per dashboard panel. They only READ from MongoDB, so the API stays fast and
// keeps working even while the ingestion side is reconnecting.
const config = require('../config');
const { Candle, StructureState, LiquidityZone, Fvg, OrderBlock, StructureEvent, Setup, SymbolStats } = require('../models');
const { HttpError, pctDistance, fmtTime } = require('../utils/helpers');

const scopeOf = (symbol, tf) => ({ exchange: config.exchange, symbol, timeframe: tf });
const strip = (doc) => { if (!doc) return doc; const { _id, exchange, ...rest } = doc; return rest; };

async function getCurrentPrice(symbol, tf) {
  const [stats, state] = await Promise.all([
    SymbolStats.findOne({ exchange: config.exchange, symbol }).lean(),
    StructureState.findOne(scopeOf(symbol, tf)).lean(),
  ]);
  return stats?.markPrice || state?.lastPrice || null;
}

async function getBias(symbol, tf) {
  const state = await StructureState.findOne(scopeOf(symbol, tf)).lean();
  if (!state) throw new HttpError(404, `No data yet for ${symbol} ${tf}. Is the symbol on the watchlist and warmed up?`);
  const word = { BULLISH: 'Bullish', BEARISH: 'Bearish', RANGING: 'Ranging' }[state.bias];
  const ev = state.biasEvent;
  const invalidation = state.bias === 'BULLISH' && state.lastSwingLow && !state.lastSwingLow.broken ? state.lastSwingLow.price
    : state.bias === 'BEARISH' && state.lastSwingHigh && !state.lastSwingHigh.broken ? state.lastSwingHigh.price : null;
  return {
    symbol, timeframe: tf,
    bias: state.bias,
    headline: ev && state.bias !== 'RANGING' ? `${word}, confirmed by ${ev.type === 'BOS' ? 'BOS' : 'CHoCH'} at ${ev.level}` : word,
    confirmingEvent: ev || null,
    invalidationLevel: invalidation, // a close beyond this flips the bias (CHoCH)
    lastPrice: state.lastPrice,
    updatedAt: state.lastCandleTime ? fmtTime(state.lastCandleTime) : null,
  };
}

async function getLiquidity(symbol, tf) {
  const [zones, price] = await Promise.all([
    LiquidityZone.find({ ...scopeOf(symbol, tf), status: { $in: ['RESTING', 'SWEPT'] } }).lean(),
    getCurrentPrice(symbol, tf),
  ]);
  const withDistance = (z) => ({ ...strip(z), distance: price ? Number((z.level - price).toFixed(8)) : null, distancePct: price ? Number(pctDistance(z.level, price).toFixed(3)) : null });
  const resting = zones.filter((z) => z.status === 'RESTING').map(withDistance);
  const swept = zones.filter((z) => z.status === 'SWEPT').sort((a, b) => b.sweptAt - a.sweptAt).slice(0, 15).map(withDistance);
  return {
    symbol, timeframe: tf, price,
    above: resting.filter((z) => z.level > price).sort((a, b) => a.level - b.level),
    below: resting.filter((z) => z.level <= price).sort((a, b) => b.level - a.level),
    recentlySwept: swept,
  };
}

async function getFvgs(symbol, tf, { status } = {}) {
  const q = { ...scopeOf(symbol, tf) };
  if (status === 'unfilled') q.status = { $in: ['UNFILLED', 'PARTIAL'] };
  else if (status === 'filled') q.status = 'FILLED';
  const rows = await Fvg.find(q).sort({ createdAt: -1 }).limit(60).lean();
  const unfilled = rows.filter((f) => f.status !== 'FILLED').map(strip);
  const filled = rows.filter((f) => f.status === 'FILLED').slice(0, 15).map(strip);
  return { symbol, timeframe: tf, unfilled, filled };
}

async function getOrderBlocks(symbol, tf) {
  const rows = await OrderBlock.find(scopeOf(symbol, tf)).sort({ createdAt: -1 }).limit(60).lean();
  return {
    symbol, timeframe: tf,
    unmitigated: rows.filter((o) => o.status === 'UNMITIGATED').map(strip),
    mitigated: rows.filter((o) => o.status === 'MITIGATED').slice(0, 15).map(strip),
  };
}

async function getEvents(symbol, tf, { limit = 50, type } = {}) {
  const q = { ...scopeOf(symbol, tf) };
  if (type) q.type = type;
  const rows = await StructureEvent.find(q).sort({ time: -1 }).limit(limit).lean();
  return { symbol, timeframe: tf, events: rows.map((e) => ({ ...strip(e), timeLabel: fmtTime(e.time) })) };
}

async function getStats(symbol) {
  const s = await SymbolStats.findOne({ exchange: config.exchange, symbol }).lean();
  if (!s) throw new HttpError(404, `No stats yet for ${symbol}`);
  return strip(s);
}

async function getSetup(symbol, tf) {
  const s = await Setup.findOne(scopeOf(symbol, tf)).lean();
  return s ? strip(s) : { status: 'NONE', reason: 'Engine is still warming up', symbol, timeframe: tf };
}

async function getSetupsAllTimeframes(symbol) {
  const rows = await Setup.find({ exchange: config.exchange, symbol, timeframe: { $in: config.timeframes } }).lean();
  return Object.fromEntries(config.timeframes.map((tf) => [tf, strip(rows.find((r) => r.timeframe === tf)) || { status: 'NONE', reason: 'Engine is still warming up' }]));
}

async function getCandles(symbol, tf, limit = 200) {
  const rows = await Candle.find(scopeOf(symbol, tf)).sort({ openTime: -1 }).limit(limit).lean();
  return { symbol, timeframe: tf, candles: rows.reverse().map(({ _id, exchange, ...c }) => c) };
}

module.exports = { getCurrentPrice, getBias, getLiquidity, getFvgs, getOrderBlocks, getEvents, getStats, getSetup, getSetupsAllTimeframes, getCandles };
