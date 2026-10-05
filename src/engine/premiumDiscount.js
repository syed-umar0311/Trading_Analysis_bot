// PREMIUM / DISCOUNT: where is price inside the current swing range? 50% = equilibrium.
// The range is clamped so it always contains the current price.
function premiumDiscount({ swingHigh, swingLow, price, bias }) {
  if (!price || swingHigh === undefined || swingLow === undefined || swingHigh === null || swingLow === null) return null;
  const high = Math.max(swingHigh, price);
  const low = Math.min(swingLow, price);
  const range = high - low;
  if (range <= 0) return null;
  const position = (price - low) / range; // 0 = bottom of range, 1 = top
  const zone = Math.abs(position - 0.5) < 0.02 ? 'EQUILIBRIUM' : position > 0.5 ? 'PREMIUM' : 'DISCOUNT';

  // OTE = 62%-79% retracement of the range, in the direction of the bias
  let ote = null;
  if (bias === 'BULLISH') ote = { low: high - 0.79 * range, high: high - 0.62 * range };
  if (bias === 'BEARISH') ote = { low: low + 0.62 * range, high: low + 0.79 * range };
  if (ote) ote.inOte = price >= ote.low && price <= ote.high;

  return { rangeHigh: high, rangeLow: low, equilibrium: low + range / 2, positionPct: Number((position * 100).toFixed(1)), zone, ote };
}

module.exports = { premiumDiscount };
