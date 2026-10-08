// STAT STRIP data: funding rate, open interest (+ trend), long/short ratio, previous-day high/low.
// Every enabled venue is queried; the numbers are merged (see engine/combine.js) and the raw per-venue values are kept
// in `byExchange`. A venue that fails is simply left out of that refresh.
const config = require('../config');
const logger = require('../utils/logger');
const { sleep } = require('../utils/helpers');
const { getExchange, venueRegistry } = require('../exchanges');
const { SymbolStats } = require('../models');
const { combineStats, combinePreviousDay, mergeOiHistory, oiChangePct } = require('../engine/combine');
const runner = require('./engineRunner');
const liquiditySources = require('./liquiditySources');

const MERGED = config.exchanges.length > 1;
let timer = null;
let running = false;

// Everything one venue can tell us about a symbol. Missing pieces stay missing (allSettled).
async function fetchVenue(venue, symbol) {
  const ex = getExchange(venue);
  const [prem, oi, hist, ls, daily, tick] = await Promise.allSettled([
    ex.getPremiumIndex(symbol),
    ex.getOpenInterest(symbol),
    ex.getOpenInterestHist(symbol, '1h', 30),
    ex.getLongShortRatio(symbol, '1h'),
    ex.getKlines(symbol, '1d', { limit: 3 }), // closed daily candles only -> last one = previous day
    ex.getTicker24h(symbol), // 24h change % for the header + watchlist
  ]);
  const snap = {};
  if (prem.status === 'fulfilled') Object.assign(snap, prem.value);
  if (oi.status === 'fulfilled' && Number.isFinite(oi.value.openInterest)) {
    snap.openInterest = oi.value.openInterest;
    if (snap.markPrice) snap.openInterestUsd = Number((oi.value.openInterest * snap.markPrice).toFixed(0));
  }
  if (ls.status === 'fulfilled' && ls.value) snap.longShort = ls.value;
  if (tick.status === 'fulfilled' && tick.value) {
    snap.change24h = tick.value.priceChangePercent;
    snap.quoteVolume24h = tick.value.quoteVolume;
  }
  const failures = [prem, oi, hist, ls, daily, tick].filter((r) => r.status === 'rejected');
  if (failures.length) logger.debug(`stats ${venue} ${symbol}: ${failures.length} request(s) failed (${failures[0].reason?.message})`);
  return {
    snap,
    oiHist: hist.status === 'fulfilled' ? hist.value : [],
    daily: daily.status === 'fulfilled' ? daily.value : [],
    ok: Object.keys(snap).length > 0 || (daily.status === 'fulfilled' && daily.value.length > 0),
  };
}

async function refreshSymbol(symbol) {
  const venues = venueRegistry.venuesOf(symbol);
  const results = await Promise.all(venues.map(async (v) => [v, await fetchVenue(v, symbol).catch(() => ({ ok: false }))]));
  const good = results.filter(([, r]) => r.ok);
  if (!good.length) throw new Error('all stats requests failed');

  const perVenue = Object.fromEntries(good.map(([v, r]) => [v, r.snap]));
  const set = combineStats(perVenue, { primary: config.primaryExchange, normalizeFunding: MERGED }) || {};

  const oi = mergeOiHistory(Object.fromEntries(good.map(([v, r]) => [v, r.oiHist])), { periodMs: 3_600_000, primary: config.primaryExchange });
  const change = oiChangePct(oi.series);
  if (change) { set.oiChangePct = change; set.oiChangeVenues = oi.venues; }

  const prev = combinePreviousDay(Object.fromEntries(good.map(([v, r]) => [v, r.daily])), { primary: config.primaryExchange, maxDeviationPct: config.merge.maxVenueDeviationPct, scope: config.exchange });
  if (prev) {
    set.pdh = prev.high;
    set.pdl = prev.low;
    set.pdDayOpenTime = prev.openTime;
  }

  if (!Object.keys(set).length) throw new Error('all stats requests failed');
  await SymbolStats.updateOne({ exchange: config.exchange, symbol }, { $set: set }, { upsert: true });

  if (set.markPrice) {
    runner.setLivePrice(symbol, set.markPrice);
    runner.refreshSetups(symbol).catch(() => {});
  }
  if (set.pdh) await liquiditySources.injectPreviousDay(symbol, set).catch((e) => logger.warn('PDH/PDL inject failed', e.message));
  return set;
}

// Poll every watched symbol one after another (gentle on exchange rate limits).
function startPolling(getSymbols) {
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const symbol of getSymbols()) {
        await refreshSymbol(symbol).catch((e) => logger.warn(`stats ${symbol}:`, e.message));
        await sleep(150);
      }
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, config.stats.pollMs);
  return tick;
}

function stopPolling() { if (timer) clearInterval(timer); }

module.exports = { refreshSymbol, startPolling, stopPolling };
