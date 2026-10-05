// ORDER BLOCKS: the last opposing candle before an impulsive move that broke structure.
//  break up  -> last DOWN candle before the move (bullish / demand block)
//  break down-> last UP candle before the move   (bearish / supply block)
// "Impulsive" = the leg from its origin to the break is at least impulseAtr x ATR long.
// Mitigated once price returns into the block.
function detectOrderBlock(window, breakEvent, atr, { impulseAtr, lookback }) {
  const j = window.length - 1; // the candle that broke structure
  const bullish = breakEvent.direction === 'BULLISH';
  const swingTime = breakEvent.broken.openTime;
  let swingIdx = window.findIndex((c) => c.openTime === swingTime);
  if (swingIdx < 0) swingIdx = 0; // swing is older than our window: use the oldest candle we have

  // 1) origin of the impulse leg = most extreme candle between the broken swing and the break
  let s = swingIdx;
  for (let i = swingIdx; i <= j; i += 1) {
    if (bullish ? window[i].low < window[s].low : window[i].high > window[s].high) s = i;
  }

  // 2) is the leg impulsive enough?
  let legExtreme = bullish ? window[s].high : window[s].low;
  for (let i = s; i <= j; i += 1) legExtreme = bullish ? Math.max(legExtreme, window[i].high) : Math.min(legExtreme, window[i].low);
  const legSize = bullish ? legExtreme - window[s].low : window[s].high - legExtreme;
  if (atr && impulseAtr && legSize < impulseAtr * atr) return null;

  // 3) last opposing candle at/before the origin
  for (let i = s; i >= Math.max(0, s - lookback); i -= 1) {
    const c = window[i];
    const opposing = bullish ? c.close < c.open : c.close > c.open;
    if (opposing) {
      return {
        key: `OB:${bullish ? 'BULLISH' : 'BEARISH'}:${c.openTime}`,
        direction: bullish ? 'BULLISH' : 'BEARISH',
        top: c.high,
        bottom: c.low,
        status: 'UNMITIGATED',
        createdAt: window[j].openTime,
        candleTime: c.openTime,
        impulseAtr: atr ? Number((legSize / atr).toFixed(2)) : null,
      };
    }
  }
  return null;
}

function updateOrderBlocks(blocks, candle) {
  const changed = [];
  for (const b of blocks.values()) {
    if (b.status === 'MITIGATED' || candle.openTime <= b.createdAt) continue;
    const touched = b.direction === 'BULLISH' ? candle.low <= b.top : candle.high >= b.bottom;
    if (touched) {
      b.status = 'MITIGATED';
      b.mitigatedAt = candle.openTime;
      changed.push(b);
    }
  }
  return changed;
}

module.exports = { detectOrderBlock, updateOrderBlocks };
