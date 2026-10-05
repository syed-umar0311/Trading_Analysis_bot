// MARKET STRUCTURE state machine (per symbol + timeframe).
//   close beyond the last swing in the trend direction  -> BOS   (trend continues)
//   close beyond the last swing against the trend       -> CHoCH (trend flips)
//   from RANGING, the first break decides the trend (labelled BOS).
// The `state` object is mutated in place; events are returned.
function createState() {
  return {
    bias: 'RANGING',
    biasEvent: null,
    lastSwingHigh: null, // { price, openTime, broken }
    lastSwingLow: null,
    candlesSinceBreak: 0,
    lastSwing: null,
  };
}

function updateStructure(state, candle, { rangingAfterCandles = 0 } = {}) {
  const events = [];
  const sh = state.lastSwingHigh;
  const sl = state.lastSwingLow;

  if (sh && !sh.broken && candle.close > sh.price) {
    const type = state.bias === 'BEARISH' ? 'CHOCH' : 'BOS';
    events.push({ type, direction: 'BULLISH', level: sh.price, broken: sh });
    sh.broken = true;
    state.bias = 'BULLISH';
  } else if (sl && !sl.broken && candle.close < sl.price) {
    const type = state.bias === 'BULLISH' ? 'CHOCH' : 'BOS';
    events.push({ type, direction: 'BEARISH', level: sl.price, broken: sl });
    sl.broken = true;
    state.bias = 'BEARISH';
  }

  if (events.length) {
    state.candlesSinceBreak = 0;
  } else {
    state.candlesSinceBreak += 1;
    // A trend with no fresh BOS/CHoCH for a long time is treated as a range.
    if (rangingAfterCandles && state.bias !== 'RANGING' && state.candlesSinceBreak >= rangingAfterCandles) {
      state.bias = 'RANGING';
    }
  }
  return events;
}

module.exports = { createState, updateStructure };
