// Bybit v5 REST client (USDT linear perpetuals, public market data only, no API key needed).
// Exposes the SAME functions as binanceClient.js so the rest of the backend does not care which venue it talks to.
//
// Bybit specifics handled here (verified against https://bybit-exchange.github.io/docs/v5):
//  - every response is HTTP 200 with { retCode, retMsg, result }; retCode !== 0 is an error
//  - klines come NEWEST FIRST, rows are [startTime, open, high, low, close, volume, turnover], and the
//    newest row can still be an open candle (its close is the last price) -> we only return closed candles
//  - kline `volume` is in base coin and `turnover` in quote coin for USDT contracts (same units as Binance)
//  - klines carry NO taker-buy volume, so Bybit candles cannot contribute to CVD (see takerVolumeBase)
//  - `openInterest` is the sum of BOTH sides, Binance reports one side -> we use `singleOpenInterest`
//  - `price24hPcnt` is a fraction (0.0142 = 1.42 %), Binance's priceChangePercent is already a percent
//  - instruments-info returns 500 rows by default and there are more symbols than that -> cursor paging
//  - HTTP 403 = IP rate limit / region block; Bybit asks to stop ALL requests for 10 minutes. Retrying makes
//    it worse, so a 403 opens a circuit breaker instead of being retried.
const config = require('../config');
const { TF_MS } = require('../utils/timeframes');
const { retry, sleep } = require('../utils/helpers');

const BASE = config.bybit.restUrl;
const CATEGORY = config.bybit.category;
const EXCHANGE = 'bybit';
const MAX_KLINES = 1000;
const BAN_MS = 10 * 60 * 1000;

// Our timeframe names <-> Bybit interval codes.
const TF_TO_INTERVAL = { '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240', '1d': 'D' };
const INTERVAL_TO_TF = Object.fromEntries(Object.entries(TF_TO_INTERVAL).map(([tf, iv]) => [iv, tf]));
// Period names for open-interest and long/short-ratio endpoints.
const PERIOD = { '5m': '5min', '15m': '15min', '30m': '30min', '1h': '1h', '4h': '4h', '1d': '1d' };

const toInterval = (tf) => {
  const iv = TF_TO_INTERVAL[tf];
  if (!iv) throw new Error(`Timeframe "${tf}" is not supported on Bybit`);
  return iv;
};
const toPeriod = (p) => PERIOD[p] || p; // accept '1h' as well as Bybit's own names

// Number or null (Bybit sends "" for fields that do not apply to a symbol).
const num = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

// ---------------------------------------------------------------- HTTP

let blockedUntil = 0; // circuit breaker opened by a 403

async function request(path, params = {}) {
  if (Date.now() < blockedUntil) {
    const err = new Error(`Bybit REST paused until ${new Date(blockedUntil).toISOString()} after a 403 (IP rate limit or region block)`);
    err.status = 403;
    err.circuitOpen = true;
    throw err;
  }
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));

  return retry(
    async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (res.status === 403) {
        blockedUntil = Date.now() + BAN_MS;
        const err = new Error(`Bybit 403 on ${path}: IP rate-limited or region-blocked. Pausing Bybit REST for 10 minutes`);
        err.status = 403;
        throw err;
      }
      if (!res.ok) {
        const body = await res.text();
        const err = new Error(`Bybit ${res.status} on ${path}: ${body.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      const json = await res.json();
      if (json.retCode !== 0) {
        const err = new Error(`Bybit retCode ${json.retCode} on ${path}: ${json.retMsg}`);
        err.retCode = json.retCode;
        // 10006 = too many visits, 10016 = server error -> worth retrying; everything else (bad symbol...) is not
        err.status = json.retCode === 10006 ? 429 : json.retCode === 10016 ? 503 : 400;
        throw err;
      }
      return json.result;
    },
    // retry on rate-limit / server errors / network errors, never on 4xx like "invalid symbol" and never on 403
    { retries: 3, baseMs: 800, shouldRetry: (e) => !e.status || e.status === 429 || e.status >= 500 }
  );
}

// ---------------------------------------------------------------- candles

// REST row -> clean candle. Prices arrive as strings, so we convert here once.
function normalizeKline(k, symbol, timeframe) {
  const openTime = Number(k[0]);
  const volume = Number(k[5]);
  return {
    exchange: EXCHANGE,
    symbol,
    timeframe,
    openTime,
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume,
    closeTime: openTime + TF_MS[timeframe] - 1, // Bybit rows have no close time
    quoteVolume: Number(k[6]), // turnover
    // Bybit klines have no taker-buy split. takerVolumeBase = 0 tells the CVD code "no order-flow data in this candle".
    takerBuyBase: 0,
    takerBuyQuote: 0,
    takerVolumeBase: 0,
  };
}

// WebSocket kline payload (one element of `data`) -> same clean shape. The symbol is NOT in the payload (it is in the topic).
function normalizeWsKline(k, symbol) {
  const timeframe = INTERVAL_TO_TF[String(k.interval)];
  if (!timeframe) throw new Error(`Unknown Bybit interval "${k.interval}"`);
  return normalizeKline([k.start, k.open, k.high, k.low, k.close, k.volume, k.turnover], symbol, timeframe);
}

// Rows ascending by time, INCLUDING a possibly still-open newest candle. Used internally so paging can tell
// "exchange has no more history" apart from "the open candle was filtered out".
async function fetchRaw(symbol, timeframe, { limit = 500, startTime, endTime } = {}) {
  const result = await request('/v5/market/kline', {
    category: CATEGORY,
    symbol,
    interval: toInterval(timeframe),
    limit: Math.min(limit, MAX_KLINES),
    start: startTime,
    end: endTime,
  });
  return (result.list || []).map((k) => normalizeKline(k, symbol, timeframe)).sort((a, b) => a.openTime - b.openTime);
}

// Returns CLOSED candles only (a candle whose closeTime is still in the future is dropped).
async function getKlines(symbol, timeframe, opts = {}) {
  const raw = await fetchRaw(symbol, timeframe, opts);
  const now = Date.now();
  return raw.filter((c) => c.closeTime < now);
}

// Fetches `count` most recent closed candles, paging backwards when count > 1000.
async function getHistory(symbol, timeframe, count) {
  const now = Date.now();
  let remaining = count + 1; // +1 because the newest row is usually the still-open candle
  let endTime;
  const all = [];
  while (remaining > 0) {
    const limit = Math.min(remaining, MAX_KLINES);
    const batch = await fetchRaw(symbol, timeframe, { limit, endTime });
    if (!batch.length) break;
    all.unshift(...batch);
    remaining -= batch.length;
    endTime = batch[0].openTime - 1;
    if (batch.length < limit) break; // exchange has no more history
    await sleep(100);
  }
  const map = new Map(all.filter((c) => c.closeTime < now).map((c) => [c.openTime, c]));
  return [...map.values()].sort((a, b) => a.openTime - b.openTime).slice(-count);
}

// Candles AFTER a given openTime up to now (used to fill gaps after downtime/reconnect).
// Bybit returns the NEWEST `limit` rows inside [start, end], so long gaps are fetched newest-first by moving `end` back.
async function getKlinesSince(symbol, timeframe, afterOpenTime) {
  const now = Date.now();
  const start = afterOpenTime + 1;
  let end = now;
  const all = [];
  for (let i = 0; i < 20; i += 1) {
    const batch = await fetchRaw(symbol, timeframe, { limit: MAX_KLINES, startTime: start, endTime: end });
    if (!batch.length) break;
    all.unshift(...batch);
    if (batch.length < MAX_KLINES) break;
    end = batch[0].openTime - 1;
    if (end < start) break;
    await sleep(100);
  }
  const map = new Map(all.filter((c) => c.closeTime < now && c.openTime >= start).map((c) => [c.openTime, c]));
  return [...map.values()].sort((a, b) => a.openTime - b.openTime);
}

// ---------------------------------------------------------------- tickers (mark, funding, OI, 24h change)

// One /tickers call carries mark price, funding, open interest and 24h stats, so the three getters below share it.
const tickerCache = new Map(); // symbol -> { at, promise }
function getTickerRow(symbol) {
  const hit = tickerCache.get(symbol);
  if (hit && Date.now() - hit.at < 2000) return hit.promise;
  const promise = request('/v5/market/tickers', { category: CATEGORY, symbol }).then((r) => {
    const row = r.list && r.list[0];
    if (!row) throw new Error(`Bybit has no ticker for ${symbol}`);
    return row;
  });
  tickerCache.set(symbol, { at: Date.now(), promise });
  promise.catch(() => tickerCache.delete(symbol)); // never cache failures
  return promise;
}

async function getPremiumIndex(symbol) {
  const t = await getTickerRow(symbol);
  return {
    markPrice: num(t.markPrice),
    indexPrice: num(t.indexPrice),
    fundingRate: num(t.fundingRate),
    nextFundingTime: num(t.nextFundingTime),
    // Bybit funding intervals differ per symbol (1h / 2h / 4h / 8h). Needed to compare funding across venues.
    fundingIntervalHours: num(t.fundingIntervalHour),
  };
}

// Single-side open interest in base coin, comparable with Binance. Falls back to `openInterest` for older payloads
// that did not have the single-side field (there it was already one-sided).
const singleSideOi = (r) => num(r.singleOpenInterest) ?? num(r.openInterest);

async function getOpenInterest(symbol) {
  const t = await getTickerRow(symbol);
  return { openInterest: singleSideOi(t), time: Date.now() };
}

async function getOpenInterestHist(symbol, period = '1h', limit = 30) {
  const result = await request('/v5/market/open-interest', {
    category: CATEGORY,
    symbol,
    intervalTime: toPeriod(period),
    limit: Math.min(limit, 200),
  });
  return (result.list || [])
    .map((r) => ({ oi: singleSideOi(r), oiValue: null, time: Number(r.timestamp) }))
    .sort((a, b) => a.time - b.time); // Bybit sends newest first
}

// Account-based long/short ratio (same definition as Binance's globalLongShortAccountRatio).
async function getLongShortRatio(symbol, period = '1h') {
  const result = await request('/v5/market/account-ratio', { category: CATEGORY, symbol, period: toPeriod(period), limit: 1 });
  const r = result.list && result.list[0]; // newest first
  if (!r) return null;
  const longAccount = Number(r.buyRatio);
  const shortAccount = Number(r.sellRatio);
  return {
    ratio: shortAccount > 0 ? Number((longAccount / shortAccount).toFixed(4)) : null,
    longAccount,
    shortAccount,
    timestamp: Number(r.timestamp),
  };
}

async function getTicker24h(symbol) {
  const t = await getTickerRow(symbol);
  const frac = num(t.price24hPcnt);
  return { priceChangePercent: frac === null ? null : Number((frac * 100).toFixed(4)), quoteVolume: num(t.turnover24h) };
}

// ---------------------------------------------------------------- depth + symbols

async function getDepth(symbol, limit = 500) {
  const d = await request('/v5/market/orderbook', { category: CATEGORY, symbol, limit: Math.min(limit, 1000) });
  const conv = (rows) => (rows || []).map(([p, q]) => [Number(p), Number(q)]);
  return { bids: conv(d.b), asks: conv(d.a), time: Date.now() };
}

let symbolCache = { at: 0, data: [] };
// All tradable USDT perpetual contracts (used for the searchable watchlist).
async function getSymbols() {
  if (Date.now() - symbolCache.at < 60 * 60 * 1000 && symbolCache.data.length) return symbolCache.data;
  const rows = [];
  let cursor;
  for (let page = 0; page < 20; page += 1) {
    const r = await request('/v5/market/instruments-info', { category: CATEGORY, limit: 1000, cursor });
    rows.push(...(r.list || []));
    cursor = r.nextPageCursor;
    if (!cursor) break; // default page size is 500 and there are more symbols than that, so paging matters
  }
  const seen = new Set();
  const data = rows
    .filter((s) => s.contractType === 'LinearPerpetual' && s.status === 'Trading' && s.quoteCoin === 'USDT')
    .filter((s) => !seen.has(s.symbol) && seen.add(s.symbol))
    .map((s) => ({ symbol: s.symbol, baseAsset: s.baseCoin, quoteAsset: s.quoteCoin }));
  symbolCache = { at: Date.now(), data };
  return data;
}

module.exports = {
  name: EXCHANGE,
  toInterval,
  INTERVAL_TO_TF,
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
  getTicker24h,
  _resetForTests: () => { blockedUntil = 0; tickerCache.clear(); symbolCache = { at: 0, data: [] }; },
};
