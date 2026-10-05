// WATCHLIST: add / remove coins (any Binance USDT perpetual) + the sidebar summary.
const config = require('../config');
const logger = require('../utils/logger');
const { HttpError } = require('../utils/helpers');
const { sortTimeframes } = require('../utils/timeframes');
const { getExchange } = require('../exchanges');
const { WatchlistItem, StructureState, SymbolStats, Setup } = require('../models');
const { computeMtf, toFrame } = require('./mtfService');
const ingestion = require('./candleIngestion');

const ex = getExchange(config.exchange);

async function seedDefaults() {
  if (await WatchlistItem.countDocuments({ exchange: config.exchange })) return;
  await WatchlistItem.insertMany(config.defaultSymbols.map((symbol) => ({ exchange: config.exchange, symbol })));
  logger.info(`Watchlist seeded: ${config.defaultSymbols.join(', ')}`);
}

const activeSymbols = async () => (await WatchlistItem.find({ exchange: config.exchange, active: true }).lean()).map((i) => i.symbol);

async function searchSymbols(search = '') {
  const all = await ex.getSymbols();
  const q = search.trim().toUpperCase();
  return (q ? all.filter((s) => s.symbol.includes(q) || s.baseAsset.includes(q)) : all).slice(0, 50);
}

async function add(symbol) {
  const known = (await ex.getSymbols()).some((s) => s.symbol === symbol);
  if (!known) throw new HttpError(400, `${symbol} is not a tradable Binance USDT perpetual`);
  const item = await WatchlistItem.findOneAndUpdate(
    { exchange: config.exchange, symbol },
    { $set: { active: true }, $setOnInsert: { ready: false, addedAt: new Date() } },
    { upsert: true, new: true }
  ).lean();
  // warm-up takes a few seconds: run it in the background and let the client poll `ready`
  ingestion.addSymbol(symbol).catch((e) => logger.error(`addSymbol ${symbol} failed:`, e.message));
  return item;
}

async function remove(symbol) {
  const res = await WatchlistItem.updateOne({ exchange: config.exchange, symbol }, { $set: { active: false, ready: false } });
  if (!res.matchedCount) throw new HttpError(404, `${symbol} is not on the watchlist`);
  ingestion.removeSymbol(symbol);
  return { symbol, removed: true };
}

// Sidebar: one row per coin with its bias tag, MTF alignment and setup status.
async function summary() {
  const items = await WatchlistItem.find({ exchange: config.exchange, active: true }).sort({ addedAt: 1 }).lean();
  const symbols = items.map((i) => i.symbol);
  const [states, stats, setups] = await Promise.all([
    StructureState.find({ exchange: config.exchange, symbol: { $in: symbols }, timeframe: { $in: config.timeframes } }).lean(),
    SymbolStats.find({ exchange: config.exchange, symbol: { $in: symbols } }).lean(),
    Setup.find({ exchange: config.exchange, symbol: { $in: symbols }, timeframe: config.primaryTimeframe }).lean(),
  ]);

  return items.map((item) => {
    const frames = sortTimeframes(config.timeframes).map((tf) => toFrame(tf, states.find((s) => s.symbol === item.symbol && s.timeframe === tf)));
    const primary = frames.find((f) => f.timeframe === config.primaryTimeframe);
    const st = stats.find((s) => s.symbol === item.symbol);
    const setup = setups.find((s) => s.symbol === item.symbol);
    const mtf = computeMtf(frames);
    return {
      symbol: item.symbol,
      ready: item.ready,
      bias: primary.bias,
      biasEvent: primary.event || null,
      price: st?.markPrice || primary.lastPrice || null,
      fundingRate: st?.fundingRate ?? null,
      mtf: { alignment: mtf.alignment, conflicts: mtf.conflicts, summary: mtf.summary, biasByTimeframe: Object.fromEntries(frames.map((f) => [f.timeframe, f.bias])) },
      setup: setup ? { status: setup.status, direction: setup.direction, rr1: setup.rr1 } : null,
    };
  });
}

module.exports = { seedDefaults, activeSymbols, searchSymbols, add, remove, summary };
