// Exchange registry. Phase 1-2 = Binance only.
// Phase 3: add bybitClient.js / okxClient.js exposing the SAME functions as binanceClient.js
// (getKlines, getHistory, getKlinesSince, getPremiumIndex, getOpenInterest, getOpenInterestHist,
//  getLongShortRatio, getDepth, getSymbols) and register them below.
const binance = require('./binanceClient');

const exchanges = { binance };

function getExchange(name = 'binance') {
  const ex = exchanges[name];
  if (!ex) throw new Error(`Exchange "${name}" is not implemented yet`);
  return ex;
}

module.exports = { getExchange, exchanges };
