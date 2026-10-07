// CANDLE INGESTION: history via REST, live candles via WebSocket, gap-fill after downtime.
const config = require("../config");
const logger = require("../utils/logger");
const { getExchange } = require("../exchanges");
const ws = require("../exchanges/binanceWs");
const { Candle, WatchlistItem } = require("../models");
const runner = require("./engineRunner");
const statsService = require("./statsService");
const liquiditySources = require("./liquiditySources");

const ex = getExchange(config.exchange);
const active = new Set();

async function saveCandles(candles) {
  if (!candles.length) return;
  await Candle.bulkWrite(
    candles.map((c) => ({
      updateOne: {
        filter: {
          exchange: c.exchange,
          symbol: c.symbol,
          timeframe: c.timeframe,
          openTime: c.openTime,
        },
        update: { $set: c },
        upsert: true,
      },
    })),
    { ordered: false },
  );
}

// Make sure MongoDB holds enough recent candles for this symbol + timeframe.
async function backfill(symbol, tf) {
  const scope = { exchange: config.exchange, symbol, timeframe: tf };
  const [count, last] = await Promise.all([
    Candle.countDocuments(scope),
    Candle.findOne(scope).sort({ openTime: -1 }).lean(),
  ]);
  const candles =
    last && count >= config.backfillCandles * 0.8
      ? await ex.getKlinesSince(symbol, tf, last.openTime)
      : await ex.getHistory(symbol, tf, config.backfillCandles);
  await saveCandles(candles);
  return candles.length;
}

// Full warm-up for one coin: history -> engines -> stats -> PDH/PDL + session zones.
async function warmUp(symbol) {
  for (const tf of config.timeframes) {
    await backfill(symbol, tf);
    await runner.bootstrap(symbol, tf);
  }
  await statsService
    .refreshSymbol(symbol)
    .catch((e) => logger.warn(`stats ${symbol}:`, e.message));
  await liquiditySources
    .refreshSymbol(symbol)
    .catch((e) => logger.warn(`sources ${symbol}:`, e.message));
  await WatchlistItem.updateOne(
    { exchange: config.exchange, symbol },
    { $set: { ready: true } },
  );
  logger.info(`${symbol} warmed up`);
}

// Fetch candles that closed while we were disconnected and push them through the engine.
async function catchUp(symbol, tf) {
  const last = runner.getLastCandleTime(symbol, tf);
  if (!last) return;
  const missed = await ex.getKlinesSince(symbol, tf, last);
  for (const c of missed) {
    await saveCandles([c]);
    await runner.onClosedCandle(c);
  }
}

async function catchUpAll() {
  for (const symbol of active) {
    for (const tf of config.timeframes) {
      await catchUp(symbol, tf).catch((e) =>
        logger.warn(`catchUp ${symbol} ${tf}:`, e.message),
      );
    }
  }
}

async function handleLiveCandle(candle) {
  if (
    !active.has(candle.symbol) ||
    !config.timeframes.includes(candle.timeframe)
  )
    return;
  try {
    await saveCandles([candle]);
    await runner.onClosedCandle(candle);
  } catch (err) {
    logger.error(
      `live candle ${candle.symbol} ${candle.timeframe}:`,
      err.message,
    );
  }
}

// Keep only symbols Binance actually lists. One unknown stream makes Binance reject the WHOLE socket.
async function onlyListed(symbols) {
  let listed;
  try {
    listed = new Set((await ex.getSymbols()).map((s) => s.symbol));
  } catch (e) {
    logger.warn("exchangeInfo unavailable, skipping symbol check:", e.message);
    return symbols;
  }
  const bad = symbols.filter((s) => !listed.has(s));
  if (bad.length) {
    logger.warn(
      `Deactivating symbols not listed on ${config.exchange}: ${bad.join(", ")}`,
    );
    await WatchlistItem.updateMany(
      { exchange: config.exchange, symbol: { $in: bad } },
      { $set: { active: false, ready: false } },
    );
  }
  return symbols.filter((s) => listed.has(s));
}

async function start(allSymbols) {
  const symbols = await onlyListed(allSymbols);
  symbols.forEach((s) => active.add(s));
  for (const symbol of symbols) {
    await warmUp(symbol).catch((e) =>
      logger.error(`warmUp ${symbol} failed:`, e.message),
    );
  }
  ws.on("candle", handleLiveCandle);
  ws.on("reconnected", () =>
    catchUpAll().catch((e) => logger.warn("catchUpAll failed", e.message)),
  );
  if (symbols.length) ws.start(symbols, config.timeframes);
  await catchUpAll(); // close the gap between warm-up and the socket opening
}

async function addSymbol(symbol) {
  active.add(symbol);
  await warmUp(symbol);
  ws.add(symbol, config.timeframes);
  await catchUpAll();
}

function removeSymbol(symbol) {
  active.delete(symbol);
  ws.remove(symbol, config.timeframes);
  runner.removeSymbol(symbol);
}

const activeSymbols = () => [...active];
function stop() {
  ws.stop();
}

module.exports = {
  start,
  addSymbol,
  removeSymbol,
  activeSymbols,
  stop,
  saveCandles,
};
