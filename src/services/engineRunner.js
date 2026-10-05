// Keeps one StructureEngine per symbol + timeframe alive in memory and connects it to MongoDB.
//  bootstrap : replay stored candles once to warm the engine (on start / when a coin is added)
//  live      : onClosedCandle() feeds one new candle, writes only what changed
// A per-engine promise queue guarantees candles are processed strictly in order.
const config = require('../config');
const logger = require('../utils/logger');
const { Candle, Setup } = require('../models');
const StructureEngine = require('../engine/StructureEngine');
const { buildSetup } = require('../engine/setup');
const { premiumDiscount } = require('../engine/premiumDiscount');
const { applyDeltas, clearDerived, clean } = require('./persistence');
const alertService = require('./alertService');

const engines = new Map();
const queues = new Map();
const livePrices = new Map(); // symbol -> latest mark price (from statsService)
const EXCHANGE = config.exchange;

const keyOf = (symbol, tf) => `${symbol}:${tf}`;
const ctxOf = (symbol, tf) => ({ exchange: EXCHANGE, symbol, timeframe: tf });

function enqueue(key, fn) {
  const run = (queues.get(key) || Promise.resolve()).catch(() => {}).then(fn);
  queues.set(key, run);
  return run;
}

async function refreshSetup(engine) {
  const snap = engine.snapshot();
  const price = livePrices.get(engine.symbol) || snap.lastPrice;
  const pd = premiumDiscount({ swingHigh: snap.lastSwingHigh?.price, swingLow: snap.lastSwingLow?.price, price, bias: snap.bias });
  const setup = buildSetup({ ...snap, price, candleTime: snap.lastCandleTime, premiumDiscount: pd }, config.setup);
  await Setup.replaceOne(ctxOf(engine.symbol, engine.timeframe), clean({ ...ctxOf(engine.symbol, engine.timeframe), ...setup }), { upsert: true });
}

async function _bootstrap(symbol, tf) {
  const rows = await Candle.find(ctxOf(symbol, tf)).sort({ openTime: -1 }).limit(config.backfillCandles).lean();
  rows.reverse();
  const engine = new StructureEngine({ exchange: EXCHANGE, symbol, timeframe: tf });
  const deltas = [];
  for (const c of rows) {
    const d = engine.process(c);
    if (d) deltas.push(d);
  }
  await clearDerived(ctxOf(symbol, tf)); // replay is the source of truth: rebuild derived data cleanly
  await applyDeltas(ctxOf(symbol, tf), deltas, { historical: true });
  engines.set(keyOf(symbol, tf), engine);
  if (rows.length) await refreshSetup(engine);
  logger.info(`Engine ready ${symbol} ${tf} (${rows.length} candles, bias ${engine.state.bias})`);
  return engine;
}

const bootstrap = (symbol, tf) => enqueue(keyOf(symbol, tf), () => _bootstrap(symbol, tf));

// Called for every newly CLOSED candle (from the WebSocket or a gap catch-up).
function onClosedCandle(candle) {
  const { symbol, timeframe: tf } = candle;
  return enqueue(keyOf(symbol, tf), async () => {
    const engine = engines.get(keyOf(symbol, tf)) || (await _bootstrap(symbol, tf));
    const delta = engine.process(candle);
    if (!delta) return; // duplicate
    await applyDeltas(ctxOf(symbol, tf), [delta], { historical: false });
    await refreshSetup(engine);
    if (delta.events.length) alertService.handleEvents(engine, delta.events).catch((e) => logger.warn('alert failed', e.message));
  });
}

// PDH/PDL and session zones are pushed into every timeframe engine of that symbol.
async function injectExternalZones(symbol, specs) {
  for (const tf of config.timeframes) {
    const key = keyOf(symbol, tf);
    if (!engines.has(key)) continue;
    await enqueue(key, async () => {
      const engine = engines.get(key);
      const deltas = specs.map((s) => engine.addExternalZone(s)).filter(Boolean);
      if (!deltas.length) return;
      await applyDeltas(ctxOf(symbol, tf), deltas, { historical: true });
      await refreshSetup(engine);
    });
  }
}

function setLivePrice(symbol, price) {
  if (price) livePrices.set(symbol, price);
}

// Re-evaluate setups when the live price moved (WAITING -> READY).
async function refreshSetups(symbol) {
  for (const tf of config.timeframes) {
    const engine = engines.get(keyOf(symbol, tf));
    if (engine && engine.lastCandleTime) await enqueue(keyOf(symbol, tf), () => refreshSetup(engine));
  }
}

function removeSymbol(symbol) {
  for (const tf of config.timeframes) engines.delete(keyOf(symbol, tf));
  livePrices.delete(symbol);
}

const hasEngine = (symbol, tf) => engines.has(keyOf(symbol, tf));
const getLastCandleTime = (symbol, tf) => engines.get(keyOf(symbol, tf))?.lastCandleTime || null;

module.exports = { bootstrap, onClosedCandle, injectExternalZones, setLivePrice, refreshSetups, removeSymbol, hasEngine, getLastCandleTime };
