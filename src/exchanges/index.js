// Exchange registry. Every client exposes the SAME functions:
//  getKlines, getHistory, getKlinesSince, getPremiumIndex, getOpenInterest, getOpenInterestHist,
//  getLongShortRatio, getDepth, getSymbols, getTicker24h
// To add another venue: write <name>Client.js + <name>Ws.js, register them below and add the name to
// SUPPORTED_EXCHANGES in src/config/index.js.
const config = require('../config');
const logger = require('../utils/logger');
const binance = require('./binanceClient');
const bybit = require('./bybitClient');

const exchanges = { binance, bybit };
const wsLoaders = { binance: () => require('./binanceWs'), bybit: () => require('./bybitWs') };

function getExchange(name = config.primaryExchange) {
  const ex = exchanges[name];
  if (!ex) {
    const hint = name === 'combined' ? ' ("combined" is a virtual scope made of the real venues, ask for one of them)' : '';
    throw new Error(`Exchange "${name}" is not implemented${hint}. Available: ${Object.keys(exchanges).join(', ')}`);
  }
  return ex;
}

// Live candle stream manager of a venue (EventEmitter: 'candle', 'reconnected').
const getWs = (name) => {
  const load = wsLoaders[name];
  if (!load) throw new Error(`No WebSocket manager for exchange "${name}"`);
  return load();
};

// ---- which enabled venues list a given coin ---------------------------------------------------------------------
// symbol -> venues, filled when a coin is warmed up. Lives here (not in a service) so every service can read it
// without creating circular imports.
const symbolVenues = new Map();
const venueRegistry = {
  get: (symbol) => symbolVenues.get(symbol),
  set: (symbol, venues) => symbolVenues.set(symbol, venues),
  delete: (symbol) => symbolVenues.delete(symbol),
  venuesOf: (symbol) => symbolVenues.get(symbol) || config.exchanges,
};

// Resolves { venues, errors } for a coin by checking each enabled venue's instrument list.
//  strict=false (boot / warm-up): a venue whose list cannot be loaded is ASSUMED to list the coin, so a temporary
//                                  outage never permanently drops a venue; its data calls simply fail and are logged.
//  strict=true  (adding a coin) : an unreachable venue does not count, so we never accept a coin we cannot verify.
async function venuesFor(symbol, { strict = false } = {}) {
  const checks = await Promise.allSettled(
    config.exchanges.map(async (name) => (await getExchange(name).getSymbols()).some((s) => s.symbol === symbol))
  );
  const venues = [];
  const errors = [];
  checks.forEach((r, i) => {
    const name = config.exchanges[i];
    if (r.status === 'fulfilled') {
      if (r.value) venues.push(name);
      return;
    }
    errors.push({ exchange: name, message: r.reason?.message || String(r.reason) });
    if (!strict) {
      logger.warn(`Could not load ${name} instruments (${r.reason?.message}); assuming ${symbol} is listed there`);
      venues.push(name);
    }
  });
  return { venues, errors };
}

module.exports = { getExchange, getWs, exchanges, venueRegistry, venuesFor };
