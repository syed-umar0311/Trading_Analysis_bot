// COMBINING SEVERAL EXCHANGES. Pure functions, no database, no network: everything here is unit-tested.
//
// Candle rule (one combined candle per symbol + timeframe + openTime):
//   open / close : volume-weighted average of the venues (the "consensus" price, not any single venue's print)
//   high / low   : the extreme across venues, so a liquidity sweep on EITHER exchange is visible to the engine
//   volume etc.  : summed
//   taker flow   : summed only over venues that report it (Bybit klines have none), see takerVolumeBase
// A venue whose close is further than maxDeviationPct from the reference venue is ignored for that candle (a
// mismatched contract, a bad print) so one broken feed cannot corrupt the structure analysis.

const round = (n) => (Number.isFinite(n) ? Number(n.toPrecision(15)) : n); // strip float noise, any magnitude
const sum = (arr) => arr.reduce((s, x) => s + x, 0);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function weightedMean(values, weights) {
  if (values.every((v) => v === values[0])) return values[0]; // identical inputs -> exact, no float noise
  const total = sum(weights);
  if (!(total > 0)) return round(sum(values) / values.length);
  return round(sum(values.map((v, i) => v * weights[i])) / total);
}

// Volume the taker-buy figure refers to. Old stored candles have no takerVolumeBase: they had taker data for the
// whole volume (Binance only), so fall back to `volume` when a takerBuyBase exists.
const takerVolume = (c) => (finite(c.takerVolumeBase) ? c.takerVolumeBase : finite(c.takerBuyBase) ? c.volume || 0 : 0);

/**
 * Merge the candles of ONE bucket (same symbol, timeframe, openTime) coming from different venues.
 * @param {object[]} candles   normalized candles, each with `.exchange`
 * @param {object}   opts      { primary, maxDeviationPct, scope = 'combined', onExclude(venue, deviationPct) }
 * @returns {object|null} combined candle (exchange = scope) or null when nothing usable
 */
function combineCandles(candles, { primary, maxDeviationPct = 0, scope = 'combined', onExclude } = {}) {
  const valid = (candles || []).filter((c) => c && [c.open, c.high, c.low, c.close].every(finite) && c.high >= c.low);
  if (!valid.length) return null;

  // reference venue = the primary one when present, otherwise the first available
  const ref = valid.find((c) => c.exchange === primary) || valid[0];
  const kept = [ref];
  for (const c of valid) {
    if (c === ref || kept.some((k) => k.exchange === c.exchange)) continue;
    const deviation = ref.close ? (Math.abs(c.close - ref.close) / ref.close) * 100 : 0;
    if (maxDeviationPct && deviation > maxDeviationPct) {
      if (onExclude) onExclude(c.exchange, deviation);
      continue;
    }
    kept.push(c);
  }

  // A venue that did not trade this bucket prints a flat candle at its previous close: that stale price must not
  // stretch the combined high/low. Ignore such candles for price as long as somebody did trade.
  const traded = kept.filter((c) => c.volume > 0);
  const used = traded.length ? traded : kept;

  // weights: quote volume when every venue has it (same unit everywhere), else base volume, else equal
  const useQuote = used.every((c) => c.quoteVolume > 0);
  const weights = used.map((c) => (useQuote ? c.quoteVolume : c.volume > 0 ? c.volume : 0));

  const open = weightedMean(used.map((c) => c.open), weights);
  const close = weightedMean(used.map((c) => c.close), weights);
  const high = Math.max(...used.map((c) => c.high), open, close);
  const low = Math.min(...used.map((c) => c.low), open, close);

  const tradesList = kept.map((c) => c.trades).filter(finite);
  const out = {
    exchange: scope,
    symbol: ref.symbol,
    timeframe: ref.timeframe,
    openTime: ref.openTime,
    closeTime: Math.max(...kept.map((c) => c.closeTime)),
    open,
    high,
    low,
    close,
    volume: round(sum(kept.map((c) => c.volume || 0))),
    quoteVolume: round(sum(kept.map((c) => c.quoteVolume || 0))),
    takerBuyBase: round(sum(kept.map((c) => c.takerBuyBase || 0))),
    takerBuyQuote: round(sum(kept.map((c) => c.takerBuyQuote || 0))),
    takerVolumeBase: round(sum(kept.map(takerVolume))),
    sources: used.map((c) => c.exchange).sort(),
  };
  if (tradesList.length) out.trades = sum(tradesList);
  return out;
}

// Group candles by openTime and combine each bucket. Returns combined candles ascending by time.
function combineSeries(candles, opts) {
  const buckets = new Map();
  for (const c of candles) {
    if (!buckets.has(c.openTime)) buckets.set(c.openTime, []);
    buckets.get(c.openTime).push(c);
  }
  return [...buckets.keys()]
    .sort((a, b) => a - b)
    .map((t) => combineCandles(buckets.get(t), opts))
    .filter(Boolean);
}

// "Previous day" candle across venues (for PDH / PDL). Input: { venue: [closed daily candles] }.
function combinePreviousDay(dailyByVenue, opts) {
  const all = Object.values(dailyByVenue).flat().filter(Boolean);
  if (!all.length) return null;
  const latest = Math.max(...all.map((c) => c.openTime));
  return combineCandles(all.filter((c) => c.openTime === latest), opts);
}

// ---------------------------------------------------------------- derivatives stats

// Funding is paid every N hours and N differs per venue / symbol (Bybit: 1, 2, 4 or 8 h). Comparing raw rates would
// be apples to oranges, so cross-venue numbers use the 8-hour-equivalent. Unknown interval = 8 h.
function normalizeFunding8h(rate, intervalHours) {
  if (!finite(rate)) return null;
  const h = finite(intervalHours) && intervalHours > 0 ? intervalHours : 8;
  return rate * (8 / h);
}

// Sum the open-interest history of several venues on a common time grid. Only grid points where EVERY venue has a
// value are used (otherwise the total would jump whenever one venue is a bucket behind). Falls back to one venue.
function mergeOiHistory(seriesByVenue, { periodMs = 3_600_000, primary } = {}) {
  const venues = Object.keys(seriesByVenue).filter((v) => (seriesByVenue[v] || []).filter((p) => finite(p.oi)).length >= 2);
  if (!venues.length) return { series: [], venues: [] };

  const grids = venues.map((v) => new Map(seriesByVenue[v].filter((p) => finite(p.oi)).map((p) => [Math.floor(p.time / periodMs) * periodMs, p.oi])));
  if (venues.length > 1) {
    const common = [...grids[0].keys()].filter((t) => grids.every((g) => g.has(t))).sort((a, b) => a - b);
    if (common.length >= 2) return { series: common.map((t) => ({ time: t, oi: sum(grids.map((g) => g.get(t))) })), venues };
  }
  const pick = venues.includes(primary) ? primary : [...venues].sort((a, b) => seriesByVenue[b].length - seriesByVenue[a].length)[0];
  const series = seriesByVenue[pick].filter((p) => finite(p.oi)).map((p) => ({ time: p.time, oi: p.oi })).sort((a, b) => a.time - b.time);
  return { series, venues: [pick] };
}

const pctChange = (now, before) => (before ? Number((((now - before) / before) * 100).toFixed(2)) : null);

// { h1, h4, h24 } % change of a merged OI series (ascending).
function oiChangePct(series) {
  if (!series || series.length < 2) return null;
  const now = series[series.length - 1].oi;
  const back = (n) => (series.length > n ? series[series.length - 1 - n].oi : null);
  return { h1: pctChange(now, back(1)), h4: pctChange(now, back(4)), h24: pctChange(now, back(24)) };
}

const weightedAvg = (entries, weightKey = 'w') => {
  const ok = entries.every((e) => finite(e[weightKey]) && e[weightKey] > 0);
  if (!ok) return sum(entries.map((e) => e.x)) / entries.length;
  return sum(entries.map((e) => e.x * e[weightKey])) / sum(entries.map((e) => e[weightKey]));
};

/**
 * Merge per-venue stat snapshots into the numbers shown in the stat strip.
 * @param {object} perVenue  { binance: { markPrice, indexPrice, fundingRate, fundingIntervalHours, nextFundingTime,
 *                              openInterest, openInterestUsd, longShort, change24h, quoteVolume24h }, bybit: {...} }
 * @param {object} opts      { primary, normalizeFunding }  normalizeFunding=true when venues are merged
 */
function combineStats(perVenue, { primary, normalizeFunding = true } = {}) {
  const venues = Object.keys(perVenue).filter((v) => perVenue[v] && Object.keys(perVenue[v]).length);
  if (!venues.length) return null;
  const pick = (field) => venues.map((v) => ({ v, x: perVenue[v][field], w: perVenue[v].openInterestUsd })).filter((e) => finite(e.x));
  const out = {};

  const marks = pick('markPrice');
  if (marks.length) out.markPrice = round(sum(marks.map((e) => e.x)) / marks.length);
  const index = pick('indexPrice');
  if (index.length) out.indexPrice = round(sum(index.map((e) => e.x)) / index.length);
  if (marks.length > 1) {
    const prices = marks.map((e) => e.x);
    out.venueSpreadPct = Number((((Math.max(...prices) - Math.min(...prices)) / Math.min(...prices)) * 100).toFixed(4));
  }

  const oi = pick('openInterest');
  if (oi.length) out.openInterest = round(sum(oi.map((e) => e.x)));
  const oiUsd = pick('openInterestUsd');
  if (oiUsd.length) out.openInterestUsd = round(sum(oiUsd.map((e) => e.x)));

  const funding = venues
    .map((v) => ({ v, x: normalizeFunding ? normalizeFunding8h(perVenue[v].fundingRate, perVenue[v].fundingIntervalHours) : perVenue[v].fundingRate, w: perVenue[v].openInterestUsd }))
    .filter((e) => finite(e.x));
  if (funding.length) out.fundingRate = round(weightedAvg(funding));

  const next = pick('nextFundingTime');
  if (next.length) out.nextFundingTime = (next.find((e) => e.v === primary) || next.sort((a, b) => a.x - b.x)[0]).x;

  const ls = venues
    .filter((v) => perVenue[v].longShort && finite(perVenue[v].longShort.longAccount))
    .map((v) => ({ v, ...perVenue[v].longShort, w: perVenue[v].openInterestUsd }));
  if (ls.length === 1) {
    const { v, w, ...rest } = ls[0];
    out.longShort = rest; // one source: pass it through untouched
  } else if (ls.length > 1) {
    const longAccount = weightedAvg(ls.map((e) => ({ x: e.longAccount, w: e.w })));
    const shortAccount = weightedAvg(ls.map((e) => ({ x: e.shortAccount, w: e.w })));
    out.longShort = {
      ratio: shortAccount > 0 ? Number((longAccount / shortAccount).toFixed(4)) : null,
      longAccount: Number(longAccount.toFixed(4)),
      shortAccount: Number(shortAccount.toFixed(4)),
      timestamp: Math.max(...ls.map((e) => e.timestamp || 0)),
    };
  }

  const change = venues
    .map((v) => ({ v, x: perVenue[v].change24h, w: perVenue[v].quoteVolume24h }))
    .filter((e) => finite(e.x));
  if (change.length) out.change24h = Number(weightedAvg(change).toFixed(4));

  out.venues = venues;
  // raw per-venue numbers stay available (undefined / NaN stripped so MongoDB stores clean JSON)
  out.byExchange = JSON.parse(JSON.stringify(Object.fromEntries(venues.map((v) => {
    const { quoteVolume24h, ...rest } = perVenue[v];
    return [v, rest];
  }))));
  return out;
}

module.exports = {
  combineCandles,
  combineSeries,
  combinePreviousDay,
  normalizeFunding8h,
  mergeOiHistory,
  oiChangePct,
  combineStats,
  takerVolume,
};
