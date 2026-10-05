// Candle length in milliseconds for each supported timeframe.
const TF_MS = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
};
const tfToMs = (tf) => TF_MS[tf];
const sortTimeframes = (tfs) => [...tfs].sort((a, b) => TF_MS[a] - TF_MS[b]);
module.exports = { TF_MS, tfToMs, sortTimeframes };
