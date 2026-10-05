// SWING DETECTION (fractal): a candle is a swing high if its high is above N candles on the left
// and N candles on the right. It is only CONFIRMED when those N right-hand candles have closed,
// so the engine checks the candle sitting N positions before the newest one.
function detectPivot(window, N) {
  const len = window.length;
  const p = len - 1 - N;
  if (p < N) return [];
  const c = window[p];
  let isHigh = true;
  let isLow = true;
  for (let k = 1; k <= N; k += 1) {
    const l = window[p - k];
    const r = window[p + k];
    if (!(c.high > l.high && c.high >= r.high)) isHigh = false; // ">=" on the right: equal highs form ONE pivot
    if (!(c.low < l.low && c.low <= r.low)) isLow = false;
  }
  const confirmedAt = window[len - 1].openTime;
  const out = [];
  if (isHigh) out.push({ type: 'HIGH', price: c.high, openTime: c.openTime, confirmedAt });
  if (isLow) out.push({ type: 'LOW', price: c.low, openTime: c.openTime, confirmedAt });
  return out;
}

// Optional ZigZag-style noise filter: ignore a swing if it moved less than `minMove` from the
// previous swing of the opposite type. minMove = minMoveAtr * ATR (0 = filter off).
function passesMinMove(swing, lastSwing, atr, minMoveAtr) {
  if (!minMoveAtr || !atr || !lastSwing || lastSwing.type === swing.type) return true;
  return Math.abs(swing.price - lastSwing.price) >= minMoveAtr * atr;
}

module.exports = { detectPivot, passesMinMove };
