// WATCHLIST: add / remove coins (any USDT perpetual listed on at least one enabled exchange) + the sidebar summary.
const config = require('../config');
const logger = require('../utils/logger');
const { HttpError } = require('../utils/helpers');
const { sortTimeframes } = require('../utils/timeframes');
const { getExchange, venuesFor, venueRegistry } = require('../exchanges');
const { WatchlistItem, StructureState, SymbolStats, Setup } = require('../models');
const { computeMtf, toFrame } = require('./mtfService');
const ingestion = require('./candleIngestion');

const SCOPE = config.exchange;

// Watchlist rows used to be stored under the single exchange ('binance'). When the venues are merged the scope becomes
// 'combined', so copy those rows over once (existing choices incl. removed coins are kept).
async function migrateLegacyItems() {
  if (config.exchanges.length < 2) return; // single-venue mode: the scope already is the venue
  const [legacy, current] = await Promise.all([
    WatchlistItem.find({ exchange: { $in: config.exchanges } }).lean(),
    WatchlistItem.find({ exchange: SCOPE }).lean(),
  ]);
  const have = new Set(current.map((i) => i.symbol));
  const copies = new Map();
  for (const i of legacy) if (!have.has(i.symbol) && !copies.has(i.symbol)) copies.set(i.symbol, { exchange: SCOPE, symbol: i.symbol, active: i.active, addedAt: i.addedAt });
  if (!copies.size) return;
  await WatchlistItem.insertMany([...copies.values()]);
  logger.info(`Watchlist migrated to "${SCOPE}": ${[...copies.keys()].join(', ')}`);
}

// Adds any DEFAULT_SYMBOLS that are not in the watchlist yet. Coins you removed earlier stay removed
// (removal only sets active:false, the document is kept), so this never resurrects them.
async function seedDefaults() {
  await migrateLegacyItems();
  const existing = new Set((await WatchlistItem.find({ exchange: SCOPE }).lean()).map((i) => i.symbol));
  const missing = config.defaultSymbols.filter((symbol) => !existing.has(symbol));
  if (!missing.length) return;
  await WatchlistItem.insertMany(missing.map((symbol) => ({ exchange: SCOPE, symbol })));
  logger.info(`Watchlist seeded: ${missing.join(', ')}`);
}

const activeSymbols = async () => (await WatchlistItem.find({ exchange: SCOPE, active: true }).lean()).map((i) => i.symbol);

// Union of every enabled venue's perpetuals; `venues` says where each coin trades.
async function allSymbols() {
  const settled = await Promise.allSettled(config.exchanges.map(async (name) => [name, await getExchange(name).getSymbols()]));
  const map = new Map();
  for (const s of settled) {
    if (s.status !== 'fulfilled') { logger.warn(`symbol list: ${s.reason.message}`); continue; }
    const [name, list] = s.value;
    for (const sym of list) {
      const e = map.get(sym.symbol) || { symbol: sym.symbol, baseAsset: sym.baseAsset, quoteAsset: sym.quoteAsset, venues: [] };
      e.venues.push(name);
      map.set(sym.symbol, e);
    }
  }
  if (!map.size) throw settled.find((s) => s.status === 'rejected').reason;
  const all = [...map.values()];
  return config.merge.requireAllVenues ? all.filter((s) => s.venues.length === config.exchanges.length) : all;
}

async function searchSymbols(search = '') {
  const all = await allSymbols();
  const q = search.trim().toUpperCase();
  return (q ? all.filter((s) => s.symbol.includes(q) || s.baseAsset.includes(q)) : all).slice(0, 50);
}

async function add(symbol) {
  const { venues, errors } = await venuesFor(symbol, { strict: true });
  if (!venues.length) {
    if (errors.length === config.exchanges.length) throw new HttpError(503, `Cannot verify ${symbol}: no exchange answered (${errors.map((e) => e.exchange).join(', ')})`);
    throw new HttpError(400, `${symbol} is not a tradable USDT perpetual on ${config.exchanges.join(' or ')}`);
  }
  if (config.merge.requireAllVenues && venues.length < config.exchanges.length) {
    throw new HttpError(400, `${symbol} is only listed on ${venues.join(', ')}; REQUIRE_ALL_EXCHANGES is on`);
  }
  const item = await WatchlistItem.findOneAndUpdate(
    { exchange: SCOPE, symbol },
    { $set: { active: true, venues }, $setOnInsert: { ready: false, addedAt: new Date() } },
    { upsert: true, new: true }
  ).lean();
  // warm-up takes a few seconds: run it in the background and let the client poll `ready`
  ingestion.addSymbol(symbol).catch((e) => logger.error(`addSymbol ${symbol} failed:`, e.message));
  return item;
}

async function remove(symbol) {
  const res = await WatchlistItem.updateOne({ exchange: SCOPE, symbol }, { $set: { active: false, ready: false } });
  if (!res.matchedCount) throw new HttpError(404, `${symbol} is not on the watchlist`);
  ingestion.removeSymbol(symbol);
  return { symbol, removed: true };
}

// Sidebar: one row per coin with its bias tag, MTF alignment and setup status.
async function summary() {
  const items = await WatchlistItem.find({ exchange: SCOPE, active: true }).sort({ addedAt: 1 }).lean();
  const symbols = items.map((i) => i.symbol);
  const [states, stats, setups] = await Promise.all([
    StructureState.find({ exchange: SCOPE, symbol: { $in: symbols }, timeframe: { $in: config.timeframes } }).lean(),
    SymbolStats.find({ exchange: SCOPE, symbol: { $in: symbols } }).lean(),
    Setup.find({ exchange: SCOPE, symbol: { $in: symbols }, timeframe: config.primaryTimeframe }).lean(),
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
      venues: venueRegistry.get(item.symbol) || (item.venues && item.venues.length ? item.venues : config.exchanges),
      bias: primary.bias,
      biasEvent: primary.event || null,
      price: st?.markPrice || primary.lastPrice || null,
      fundingRate: st?.fundingRate ?? null,
      mtf: { alignment: mtf.alignment, conflicts: mtf.conflicts, summary: mtf.summary, biasByTimeframe: Object.fromEntries(frames.map((f) => [f.timeframe, f.bias])) },
      setup: setup ? { status: setup.status, direction: setup.direction, rr1: setup.rr1 } : null,
      change24h: st?.change24h ?? null,
    };
  });
}

module.exports = { seedDefaults, activeSymbols, searchSymbols, add, remove, summary };
