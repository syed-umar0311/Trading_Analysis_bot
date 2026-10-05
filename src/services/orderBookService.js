// ORDER BOOK IMBALANCE (Phase 3): bid vs ask volume within +-bandPct of the mid price.
const config = require('../config');
const { getExchange } = require('../exchanges');

const ex = getExchange(config.exchange);
const cache = new Map();

async function getImbalance(symbol) {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < config.orderBook.cacheMs) return hit.data;

  const { bids, asks } = await ex.getDepth(symbol, config.orderBook.depthLimit);
  if (!bids.length || !asks.length) return null;
  const mid = (bids[0][0] + asks[0][0]) / 2;
  const band = (mid * config.orderBook.bandPct) / 100;

  const bidVol = bids.filter(([p]) => p >= mid - band).reduce((s, [, q]) => s + q, 0);
  const askVol = asks.filter(([p]) => p <= mid + band).reduce((s, [, q]) => s + q, 0);
  const total = bidVol + askVol;
  const imbalance = total ? (bidVol - askVol) / total : 0; // -1 (all asks) .. +1 (all bids)

  const data = {
    midPrice: mid,
    bandPct: config.orderBook.bandPct,
    bidVolume: Number(bidVol.toFixed(4)),
    askVolume: Number(askVol.toFixed(4)),
    imbalance: Number(imbalance.toFixed(3)),
    pressure: imbalance > 0.15 ? 'BUY_PRESSURE' : imbalance < -0.15 ? 'SELL_PRESSURE' : 'BALANCED',
    // how far the fetched depth really reaches on each side, if it is narrower than the band the numbers are partial
    coveragePct: { bids: Number((((mid - bids[bids.length - 1][0]) / mid) * 100).toFixed(3)), asks: Number((((asks[asks.length - 1][0] - mid) / mid) * 100).toFixed(3)) },
    time: Date.now(),
  };
  cache.set(symbol, { at: Date.now(), data });
  return data;
}

module.exports = { getImbalance };
