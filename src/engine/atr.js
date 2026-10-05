// Average True Range = average candle "size" including gaps. Used to scale every threshold.
function trueRange(c, prevClose) {
  if (prevClose === undefined) return c.high - c.low;
  return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
}

function calcAtr(candles, period = 14) {
  if (candles.length < 2) return null;
  const start = Math.max(1, candles.length - period);
  let sum = 0;
  let n = 0;
  for (let i = start; i < candles.length; i += 1) {
    sum += trueRange(candles[i], candles[i - 1].close);
    n += 1;
  }
  return n ? sum / n : null;
}

module.exports = { calcAtr, trueRange };
