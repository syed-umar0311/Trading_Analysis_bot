// Binance USD-M Futures REST client (public market data only, no API key needed).
const config = require('../config');
const { TF_MS } = require('../utils/timeframes');
const { retry, sleep } = require('../utils/helpers');

const BASE = config.binance.restUrl;
const EXCHANGE = 'binance';

async function request(path, params = {}) {
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));

  return retry(
    async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        const body = await res.text();
        const err = new Error(`Binance ${res.status} on ${path}: ${body.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
    // retry on rate-limit / server errors / network errors, never on 4xx like "invalid symbol"
    { retries: 3, baseMs: 800, shouldRetry: (e) => !e.status || e.status === 429 || e.status >= 500 }
  );
}

// Raw kline array -> clean object. Prices arrive as strings, so we convert here once.
function normalizeKline(k, symbol, timeframe) {
  return {
    exchange: EXCHANGE,
    symbol,
    timeframe,
    openTime: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    closeTime: Number(k[6]),
    quoteVolume: Number(k[7]),
    trades: Number(k[8]),
    takerBuyBase: Number(k[9]),
    takerBuyQuote: Number(k[10]),
  };
}

// WebSocket kline payload ("k" object) -> same clean shape.
function normalizeWsKline(k) {
  return {
    exchange: EXCHANGE,
    symbol: k.s,
    timeframe: k.i,
    openTime: Number(k.t),
    open: Number(k.o),
    high: Number(k.h),
    low: Number(k.l),
    close: Number(k.c),
    volume: Number(k.v),
    closeTime: Number(k.T),
    quoteVolume: Number(k.q),
    trades: Number(k.n),
    takerBuyBase: Number(k.V),
    takerBuyQuote: Number(k.Q),
  };
}

// Returns CLOSED candles only (a candle whose closeTime is still in the future is dropped).
async function getKlines(symbol, timeframe, { limit = 500, startTime, endTime } = {}) {
  const raw = await request('/fapi/v1/klines', { symbol, interval: timeframe, limit: Math.min(limit, 1500), startTime, endTime });
  const now = Date.now();
  return raw.map((k) => normalizeKline(k, symbol, timeframe)).filter((c) => c.closeTime < now);
}

// Fetches `count` most recent closed candles, paging backwards when count > 1500.
async function getHistory(symbol, timeframe, count) {
  let remaining = count;
  let endTime;
  const all = [];
  while (remaining > 0) {
    const batch = await getKlines(symbol, timeframe, { limit: Math.min(remaining, 1500), endTime });
    if (!batch.length) break;
    all.unshift(...batch);
    remaining -= batch.length;
    endTime = batch[0].openTime - 1;
    if (batch.length < Math.min(remaining + batch.length, 1500)) break; // exchange has no more history
    await sleep(150);
  }
  // de-duplicate + sort ascending
  const map = new Map(all.map((c) => [c.openTime, c]));
  return [...map.values()].sort((a, b) => a.openTime - b.openTime).slice(-count);
}

// Candles AFTER a given openTime up to now (used to fill gaps after downtime/reconnect).
async function getKlinesSince(symbol, timeframe, afterOpenTime) {
  const out = [];
  let start = afterOpenTime + 1;
  const step = TF_MS[timeframe];
  for (let i = 0; i < 20; i += 1) {
    const batch = await getKlines(symbol, timeframe, { limit: 1500, startTime: start });
    if (!batch.length) break;
    out.push(...batch);
    start = batch[batch.length - 1].openTime + step;
    if (batch.length < 1500) break;
    await sleep(150);
  }
  return out;
}

async function getPremiumIndex(symbol) {
  const d = await request('/fapi/v1/premiumIndex', { symbol });
  return {
    markPrice: Number(d.markPrice),
    indexPrice: Number(d.indexPrice),
    fundingRate: Number(d.lastFundingRate),
    nextFundingTime: Number(d.nextFundingTime),
  };
}

async function getOpenInterest(symbol) {
  const d = await request('/fapi/v1/openInterest', { symbol });
  return { openInterest: Number(d.openInterest), time: Number(d.time) };
}

async function getOpenInterestHist(symbol, period = '1h', limit = 30) {
  const rows = await request('/futures/data/openInterestHist', { symbol, period, limit });
  return rows.map((r) => ({ oi: Number(r.sumOpenInterest), oiValue: Number(r.sumOpenInterestValue), time: Number(r.timestamp) }));
}

async function getLongShortRatio(symbol, period = '1h') {
  const rows = await request('/futures/data/globalLongShortAccountRatio', { symbol, period, limit: 1 });
  if (!rows.length) return null;
  const r = rows[rows.length - 1];
  return { ratio: Number(r.longShortRatio), longAccount: Number(r.longAccount), shortAccount: Number(r.shortAccount), timestamp: Number(r.timestamp) };
}

async function getDepth(symbol, limit = 500) {
  const d = await request('/fapi/v1/depth', { symbol, limit });
  const conv = (rows) => rows.map(([p, q]) => [Number(p), Number(q)]);
  return { bids: conv(d.bids), asks: conv(d.asks), time: Date.now() };
}

let symbolCache = { at: 0, data: [] };
// All tradable USDT perpetual contracts (used for the searchable watchlist).
async function getSymbols() {
  if (Date.now() - symbolCache.at < 60 * 60 * 1000 && symbolCache.data.length) return symbolCache.data;
  const info = await request('/fapi/v1/exchangeInfo');
  const data = info.symbols
    .filter((s) => s.contractType === 'PERPETUAL' && s.status === 'TRADING' && s.quoteAsset === 'USDT')
    .map((s) => ({ symbol: s.symbol, baseAsset: s.baseAsset, quoteAsset: s.quoteAsset }));
  symbolCache = { at: Date.now(), data };
  return data;
}

module.exports = {
  name: EXCHANGE,
  normalizeKline,
  normalizeWsKline,
  getKlines,
  getHistory,
  getKlinesSince,
  getPremiumIndex,
  getOpenInterest,
  getOpenInterestHist,
  getLongShortRatio,
  getDepth,
  getSymbols,
};
