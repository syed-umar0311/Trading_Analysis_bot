// FAIR VALUE GAP: 3 candles where candle 1 and candle 3 do not overlap.
//  bullish: high(c1) < low(c3)    bearish: low(c1) > high(c3)
// Filled once price trades back through the whole gap.
function detectFvg(window, atr, minAtr) {
  const len = window.length;
  if (len < 3) return null;
  const c1 = window[len - 3];
  const c2 = window[len - 2];
  const c3 = window[len - 1];
  let fvg = null;
  if (c1.high < c3.low) {
    fvg = { direction: 'BULLISH', bottom: c1.high, top: c3.low };
  } else if (c1.low > c3.high) {
    fvg = { direction: 'BEARISH', bottom: c3.high, top: c1.low };
  }
  if (!fvg) return null;
  fvg.size = fvg.top - fvg.bottom;
  if (minAtr && atr && fvg.size < minAtr * atr) return null; // ignore tiny gaps
  return {
    key: `FVG:${fvg.direction}:${c2.openTime}`,
    ...fvg,
    status: 'UNFILLED',
    createdAt: c3.openTime,
    middleTime: c2.openTime,
  };
}

function updateFvgs(fvgs, candle) {
  const changed = [];
  for (const f of fvgs.values()) {
    if (f.status === 'FILLED' || candle.openTime <= f.createdAt) continue;
    const before = f.status;
    if (f.direction === 'BULLISH') {
      if (candle.low <= f.bottom) f.status = 'FILLED';
      else if (candle.low < f.top) f.status = 'PARTIAL';
    } else if (candle.high >= f.top) f.status = 'FILLED';
    else if (candle.high > f.bottom) f.status = 'PARTIAL';
    if (f.status !== before) {
      if (f.status === 'FILLED') f.filledAt = candle.openTime;
      changed.push(f);
    }
  }
  return changed;
}

module.exports = { detectFvg, updateFvgs };
