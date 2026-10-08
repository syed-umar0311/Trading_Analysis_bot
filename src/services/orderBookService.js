// ORDER BOOK IMBALANCE (Phase 3): bid vs ask volume within +-bandPct of the mid price.
// With several venues the bid/ask volumes of every book are added up (the real combined liquidity near price) and each
// venue's own reading is kept in `byExchange`.
const config = require('../config');
const { getExchange, venueRegistry } = require('../exchanges');

const cache = new Map();
const r = (n, dp) => Number(n.toFixed(dp));
const pressureOf = (imbalance) => (imbalance > 0.15 ? 'BUY_PRESSURE' : imbalance < -0.15 ? 'SELL_PRESSURE' : 'BALANCED');

function analyse({ bids, asks }) {
  if (!bids.length || !asks.length) return null;
  const mid = (bids[0][0] + asks[0][0]) / 2;
  const band = (mid * config.orderBook.bandPct) / 100;
  const bidVol = bids.filter(([p]) => p >= mid - band).reduce((s, [, q]) => s + q, 0);
  const askVol = asks.filter(([p]) => p <= mid + band).reduce((s, [, q]) => s + q, 0);
  return {
    mid, bidVol, askVol,
    // how far the fetched depth really reaches on each side; if it is narrower than the band the numbers are partial
    coverage: { bids: ((mid - bids[bids.length - 1][0]) / mid) * 100, asks: ((asks[asks.length - 1][0] - mid) / mid) * 100 },
  };
}

async function getImbalance(symbol) {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < config.orderBook.cacheMs) return hit.data;

  const venues = venueRegistry.venuesOf(symbol);
  const settled = await Promise.allSettled(venues.map(async (v) => [v, analyse(await getExchange(v).getDepth(symbol, config.orderBook.depthLimit))]));
  const books = settled.filter((s) => s.status === 'fulfilled' && s.value[1]).map((s) => s.value);
  if (!books.length) {
    const failed = settled.find((s) => s.status === 'rejected');
    if (failed) throw failed.reason; // same behaviour as before: caller logs a warning
    return null;
  }

  const bidVol = books.reduce((s, [, b]) => s + b.bidVol, 0);
  const askVol = books.reduce((s, [, b]) => s + b.askVol, 0);
  const total = bidVol + askVol;
  const imbalance = total ? (bidVol - askVol) / total : 0; // -1 (all asks) .. +1 (all bids)
  const data = {
    midPrice: books.reduce((s, [, b]) => s + b.mid, 0) / books.length,
    bandPct: config.orderBook.bandPct,
    bidVolume: r(bidVol, 4),
    askVolume: r(askVol, 4),
    imbalance: r(imbalance, 3),
    pressure: pressureOf(imbalance),
    // worst case across venues (the combined number is only as complete as its shallowest book)
    coveragePct: { bids: r(Math.min(...books.map(([, b]) => b.coverage.bids)), 3), asks: r(Math.min(...books.map(([, b]) => b.coverage.asks)), 3) },
    venues: books.map(([v]) => v),
    byExchange: Object.fromEntries(books.map(([v, b]) => {
      const t = b.bidVol + b.askVol;
      const imb = t ? (b.bidVol - b.askVol) / t : 0;
      return [v, { midPrice: b.mid, bidVolume: r(b.bidVol, 4), askVolume: r(b.askVol, 4), imbalance: r(imb, 3), pressure: pressureOf(imb), coveragePct: { bids: r(b.coverage.bids, 3), asks: r(b.coverage.asks, 3) } }];
    })),
    time: Date.now(),
  };
  cache.set(symbol, { at: Date.now(), data });
  return data;
}

module.exports = { getImbalance };
