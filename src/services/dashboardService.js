// Builds the whole dashboard payload for one symbol in a single response.
const config = require('../config');
const { venueRegistry } = require('../exchanges');
const panels = require('./panelService');
const { getMtf } = require('./mtfService');
const { getIndicators } = require('./indicatorService');

async function getDashboard(symbol, tf, { includeOrderBook = true } = {}) {
  const [bias, setup, setupsByTimeframe, liquidity, fvg, orderBlocks, stats, timeline, mtf, indicators] = await Promise.all([
    panels.getBias(symbol, tf),
    panels.getSetup(symbol, tf),
    panels.getSetupsAllTimeframes(symbol),
    panels.getLiquidity(symbol, tf),
    panels.getFvgs(symbol, tf),
    panels.getOrderBlocks(symbol, tf),
    panels.getStats(symbol).catch(() => null),
    panels.getEvents(symbol, tf, { limit: 50 }),
    getMtf(symbol),
    getIndicators(symbol, tf, { includeOrderBook }).catch(() => null),
  ]);
  return {
    symbol,
    timeframe: tf,
    generatedAt: Date.now(),
    dataSources: { scope: config.exchange, mode: config.exchanges.length > 1 ? 'COMBINED' : 'SINGLE', exchanges: venueRegistry.venuesOf(symbol) },
    biasBanner: bias,
    suggestedSetup: setup,
    setupsByTimeframe, // open question #4: one setup per timeframe is available here
    liquidity,
    fairValueGaps: fvg,
    orderBlocks,
    statStrip: stats && {
      markPrice: stats.markPrice,
      fundingRate: stats.fundingRate,
      nextFundingTime: stats.nextFundingTime,
      openInterest: stats.openInterest,
      openInterestUsd: stats.openInterestUsd,
      oiChangePct: stats.oiChangePct,
      longShort: stats.longShort,
      previousDayHigh: stats.pdh,
      previousDayLow: stats.pdl,
      change24h: stats.change24h,
      venueSpreadPct: stats.venueSpreadPct ?? null,
      byExchange: stats.byExchange || null,
    },
    timeline: timeline.events,
    multiTimeframe: mtf,
    indicators,
  };
}

module.exports = { getDashboard };
