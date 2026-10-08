// CANDLE INGESTION: history via REST, live candles via WebSocket, gap-fill after downtime.
// With several venues enabled (EXCHANGES=binance,bybit):
//   raw candles are stored per venue ('binance', 'bybit'); a merged 'combined' candle per bucket is what the engine reads.
// With one venue the flow is exactly the original single-exchange one.
const config = require('../config');
const logger = require('../utils/logger');
const { TF_MS } = require('../utils/timeframes');
const { getExchange, getWs, venueRegistry, venuesFor } = require('../exchanges');
const { Candle, WatchlistItem } = require('../models');
const { combineCandles, combineSeries } = require('../engine/combine');
const MergeBuffer = require('./mergeBuffer');
const runner = require('./engineRunner');
const statsService = require('./statsService');
const liquiditySources = require('./liquiditySources');

const VENUES = config.exchanges;
const MERGED = VENUES.length > 1;
const SCOPE = config.exchange; // 'combined' or the single venue
const active = new Set();
const { venuesOf } = venueRegistry;

const mergeOpts = () => ({
  primary: config.primaryExchange,
  maxDeviationPct: config.merge.maxVenueDeviationPct,
  scope: SCOPE,
  onExclude: (venue, dev) => logger.warn(`combine: ignoring ${venue} for a candle, close differs ${dev.toFixed(2)}% from ${config.primaryExchange}`),
});

async function saveCandles(candles) {
  if (!candles.length) return;
  await Candle.bulkWrite(
    candles.map((c) => ({
      updateOne: { filter: { exchange: c.exchange, symbol: c.symbol, timeframe: c.timeframe, openTime: c.openTime }, update: { $set: c }, upsert: true },
    })),
    { ordered: false }
  );
}

// Make sure MongoDB holds enough recent raw candles for this venue + symbol + timeframe.
async function backfill(symbol, venue, tf) {
  const ex = getExchange(venue);
  const scope = { exchange: venue, symbol, timeframe: tf };
  const [count, last] = await Promise.all([Candle.countDocuments(scope), Candle.findOne(scope).sort({ openTime: -1 }).lean()]);
  const candles = last && count >= config.backfillCandles * 0.8
    ? await ex.getKlinesSince(symbol, tf, last.openTime)
    : await ex.getHistory(symbol, tf, config.backfillCandles);
  await saveCandles(candles);
  return candles.length;
}

// Combine the stored raw candles of the given buckets (or the whole recent window) and store the result.
async function combineFromDb(symbol, tf, openTimes) {
  const venues = venuesOf(symbol);
  const q = { exchange: { $in: venues }, symbol, timeframe: tf };
  q.openTime = openTimes ? { $in: openTimes } : { $gte: Date.now() - (config.backfillCandles + 50) * TF_MS[tf] };
  const rows = await Candle.find(q).lean();
  const combined = combineSeries(rows, mergeOpts());
  await saveCandles(combined);
  return combined;
}

// Full warm-up for one coin: history -> (merge) -> engines -> stats -> PDH/PDL + session zones.
async function warmUp(symbol) {
  const { venues } = await venuesFor(symbol);
  if (!venues.length) throw new Error(`${symbol} is not listed on any enabled exchange (${VENUES.join(', ')})`);
  venueRegistry.set(symbol, venues);

  for (const tf of config.timeframes) {
    const results = await Promise.allSettled(venues.map((v) => backfill(symbol, v, tf)));
    results.forEach((r, i) => { if (r.status === 'rejected') logger.warn(`backfill ${venues[i]} ${symbol} ${tf}: ${r.reason.message}`); });
    if (results.every((r) => r.status === 'rejected')) throw results[0].reason;
    if (MERGED) await combineFromDb(symbol, tf);
    await runner.bootstrap(symbol, tf);
  }
  await statsService.refreshSymbol(symbol).catch((e) => logger.warn(`stats ${symbol}:`, e.message));
  await liquiditySources.refreshSymbol(symbol).catch((e) => logger.warn(`sources ${symbol}:`, e.message));
  await WatchlistItem.updateOne({ exchange: SCOPE, symbol }, { $set: { ready: true, venues } });
  logger.info(`${symbol} warmed up on ${venues.join('+')}`);
}

// Fetch candles that closed while we were disconnected and push them through the engine.
async function catchUp(symbol, tf) {
  const lastEngine = runner.getLastCandleTime(symbol, tf);
  if (!lastEngine) return;
  const touched = new Set();
  const singleVenueCandles = [];
  await Promise.all(venuesOf(symbol).map(async (venue) => {
    try {
      // each venue is filled from ITS OWN last stored candle, so a venue that was down gets its gap repaired
      const last = await Candle.findOne({ exchange: venue, symbol, timeframe: tf }).sort({ openTime: -1 }).select('openTime').lean();
      const missed = await getExchange(venue).getKlinesSince(symbol, tf, last ? last.openTime : lastEngine);
      await saveCandles(missed);
      missed.forEach((c) => { touched.add(c.openTime); singleVenueCandles.push(c); });
    } catch (e) {
      logger.warn(`catchUp ${venue} ${symbol} ${tf}: ${e.message}`);
    }
  }));

  if (!MERGED) {
    for (const c of singleVenueCandles.sort((a, b) => a.openTime - b.openTime)) await runner.onClosedCandle(c);
    return;
  }
  const buckets = [...touched].filter((t) => t > lastEngine).sort((a, b) => a - b);
  if (!buckets.length) return;
  for (const c of await combineFromDb(symbol, tf, buckets)) await runner.onClosedCandle(c);
}

async function catchUpAll() {
  for (const symbol of active) {
    for (const tf of config.timeframes) {
      await catchUp(symbol, tf).catch((e) => logger.warn(`catchUp ${symbol} ${tf}:`, e.message));
    }
  }
}

// ---- live candles -------------------------------------------------------------------------------------------------
const buffer = MERGED
  ? new MergeBuffer({
      graceMs: config.merge.graceMs,
      onFlush: async (candles) => {
        const combined = combineCandles(candles, mergeOpts());
        if (!combined) return;
        await saveCandles([combined]);
        await runner.onClosedCandle(combined);
      },
      // a venue delivered after the merge: refresh the STORED combined candle (the engine already processed the bucket;
      // a restart replays the improved candle)
      onLate: (c) => combineFromDb(c.symbol, c.timeframe, [c.openTime]),
      onError: (e) => logger.error('merge failed:', e.message),
    })
  : null;

async function handleLiveCandle(candle) {
  if (!active.has(candle.symbol) || !config.timeframes.includes(candle.timeframe)) return;
  try {
    await saveCandles([candle]); // raw candle first, so late-merge can read it back from the DB
    if (MERGED) buffer.add(candle, venuesOf(candle.symbol));
    else await runner.onClosedCandle(candle);
  } catch (err) {
    logger.error(`live candle ${candle.exchange} ${candle.symbol} ${candle.timeframe}:`, err.message);
  }
}

const listedOn = (symbols, venue) => symbols.filter((s) => venuesOf(s).includes(venue));

async function start(symbols) {
  symbols.forEach((s) => active.add(s));
  for (const symbol of symbols) {
    await warmUp(symbol).catch((e) => logger.error(`warmUp ${symbol} failed:`, e.message));
  }
  for (const venue of VENUES) {
    const ws = getWs(venue);
    ws.on('candle', handleLiveCandle);
    ws.on('reconnected', () => catchUpAll().catch((e) => logger.warn('catchUpAll failed', e.message)));
    const list = listedOn(symbols, venue);
    if (list.length) ws.start(list, config.timeframes);
  }
  await catchUpAll(); // close the gap between warm-up and the sockets opening
}

async function addSymbol(symbol) {
  active.add(symbol);
  await warmUp(symbol);
  for (const venue of venuesOf(symbol)) getWs(venue).add(symbol, config.timeframes);
  await catchUpAll();
}

function removeSymbol(symbol) {
  active.delete(symbol);
  for (const venue of VENUES) getWs(venue).remove(symbol, config.timeframes);
  runner.removeSymbol(symbol);
  venueRegistry.delete(symbol);
}

const activeSymbols = () => [...active];
function stop() {
  VENUES.forEach((v) => getWs(v).stop());
  if (buffer) buffer.clear();
}

module.exports = { start, addSymbol, removeSymbol, activeSymbols, stop, saveCandles, _handleLiveCandle: handleLiveCandle, _catchUp: catchUp, _warmUp: warmUp, _active: active };
