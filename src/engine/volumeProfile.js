// VOLUME PROFILE: how much volume traded at each price. Point of Control (POC) = busiest price.
// Candle volume is spread evenly across the price bins the candle touched (approximation).
function volumeProfile(candles, { bins = 48, valueAreaPct = 0.7 } = {}) {
  if (!candles.length) return null;
  const lo = Math.min(...candles.map((c) => c.low));
  const hi = Math.max(...candles.map((c) => c.high));
  if (hi <= lo) return null;
  const step = (hi - lo) / bins;
  const vols = new Array(bins).fill(0);

  for (const c of candles) {
    const a = Math.min(bins - 1, Math.floor((c.low - lo) / step));
    const b = Math.min(bins - 1, Math.floor((c.high - lo) / step));
    const share = (c.volume || 0) / (b - a + 1);
    for (let i = a; i <= b; i += 1) vols[i] += share;
  }

  const total = vols.reduce((s, v) => s + v, 0);
  let poc = 0;
  vols.forEach((v, i) => { if (v > vols[poc]) poc = i; });

  // value area: grow outward from the POC until it holds valueAreaPct of all volume
  let l = poc;
  let r = poc;
  let acc = vols[poc];
  while (acc < total * valueAreaPct && (l > 0 || r < bins - 1)) {
    const left = l > 0 ? vols[l - 1] : -1;
    const right = r < bins - 1 ? vols[r + 1] : -1;
    if (left >= right) { l -= 1; acc += vols[l]; } else { r += 1; acc += vols[r]; }
  }
  const mid = (i) => lo + step * (i + 0.5);
  return {
    poc: mid(poc),
    valueAreaHigh: lo + step * (r + 1),
    valueAreaLow: lo + step * l,
    rangeHigh: hi,
    rangeLow: lo,
    bins: vols.map((v, i) => ({ price: mid(i), volume: v })),
  };
}

module.exports = { volumeProfile };
