// CUMULATIVE VOLUME DELTA from candle data.
// Binance gives "taker buy volume" per candle, so delta = buys - sells = 2*takerBuy - volume.
// Bybit klines have no taker split, so a combined candle carries `takerVolumeBase` = the volume of the venues that DO
// report it. Delta is computed over that volume only (never "all volume vs buy volume of one venue", which would bias
// the CVD negative) and `coveragePct` tells how much of the traded volume the order-flow numbers actually cover.
// Candles without takerVolumeBase (older stored rows) count as fully covered, exactly as before.
function computeCvd(candles, divergenceLookback = 20) {
  let running = 0;
  let covered = 0;
  let traded = 0;
  const series = candles.map((c) => {
    const tv = Number.isFinite(c.takerVolumeBase) ? c.takerVolumeBase : c.volume || 0;
    const delta = 2 * (c.takerBuyBase || 0) - tv;
    running += delta;
    covered += tv;
    traded += c.volume || 0;
    return { time: c.openTime, delta, cvd: running };
  });
  const coveragePct = traded > 0 ? Number(((covered / traded) * 100).toFixed(1)) : null;
  if (!series.length) return { series: [], total: 0, trend: 'FLAT', divergence: null, coveragePct };

  // Divergence: price at a fresh extreme but CVD is not confirming it.
  let divergence = null;
  const n = Math.min(divergenceLookback, candles.length);
  if (n >= 8) {
    const idxs = [...Array(n).keys()].map((i) => candles.length - n + i);
    const closes = idxs.map((i) => candles[i].close);
    const cvds = idxs.map((i) => series[i].cvd);
    const maxP = Math.max(...closes);
    const minP = Math.min(...closes);
    const recent = closes.slice(-3);
    if (recent.includes(maxP) && Math.max(...cvds.slice(-3)) < Math.max(...cvds)) divergence = 'BEARISH';
    else if (recent.includes(minP) && Math.min(...cvds.slice(-3)) > Math.min(...cvds)) divergence = 'BULLISH';
  }

  const k = Math.min(10, series.length - 1);
  const slope = series[series.length - 1].cvd - series[series.length - 1 - k].cvd;
  return { series: series.slice(-100), total: running, trend: slope > 0 ? 'RISING' : slope < 0 ? 'FALLING' : 'FLAT', divergence, coveragePct };
}

module.exports = { computeCvd };
