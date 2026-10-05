// STAT STRIP data: funding rate, open interest (+ trend), long/short ratio, previous-day high/low.
const config = require('../config');
const logger = require('../utils/logger');
const { sleep } = require('../utils/helpers');
const { getExchange } = require('../exchanges');
const { SymbolStats } = require('../models');
const runner = require('./engineRunner');
const liquiditySources = require('./liquiditySources');

const ex = getExchange(config.exchange);
let timer = null;
let running = false;

const pct = (now, before) => (before ? Number((((now - before) / before) * 100).toFixed(2)) : null);

async function refreshSymbol(symbol) {
  const [prem, oi, hist, ls, daily] = await Promise.allSettled([
    ex.getPremiumIndex(symbol),
    ex.getOpenInterest(symbol),
    ex.getOpenInterestHist(symbol, '1h', 30),
    ex.getLongShortRatio(symbol, '1h'),
    ex.getKlines(symbol, '1d', { limit: 3 }), // closed daily candles only -> last one = previous day
  ]);
  const set = {};

  if (prem.status === 'fulfilled') Object.assign(set, prem.value);
  if (oi.status === 'fulfilled') {
    set.openInterest = oi.value.openInterest;
    const mark = set.markPrice;
    if (mark) set.openInterestUsd = Number((oi.value.openInterest * mark).toFixed(0));
  }
  if (hist.status === 'fulfilled' && hist.value.length >= 2) {
    const h = [...hist.value].sort((a, b) => a.time - b.time);
    const now = h[h.length - 1].oi;
    const back = (n) => (h.length > n ? h[h.length - 1 - n].oi : null);
    set.oiChangePct = { h1: pct(now, back(1)), h4: pct(now, back(4)), h24: pct(now, back(24)) };
  }
  if (ls.status === 'fulfilled' && ls.value) set.longShort = ls.value;
  if (daily.status === 'fulfilled' && daily.value.length) {
    const prev = daily.value[daily.value.length - 1];
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

// Poll every watched symbol one after another (gentle on Binance rate limits).
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
