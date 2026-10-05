// SUGGESTED SETUP: derived from the engine output (no separate model).
//  Entry : nearest unmitigated FVG / order block in the bias direction that overlaps a reclaimed liquidity level
//  Stop  : just beyond the reclaimed level / zone that would invalidate the idea
//  TP1/2 : next one or two untouched liquidity levels in the bias direction
//  R:R   : computed from those prices and always surfaced
const { roundPrice } = require('../utils/helpers');

function buildSetup(ctx, params) {
  const { bias, price, atr, zones, fvgs, orderBlocks, premiumDiscount: pd, tfMs, candleTime, biasEvent } = ctx;
  const none = (reason) => ({ status: 'NONE', direction: null, reason, warnings: [], confidence: 0, candleTime });

  if (!price || !atr) return none('Not enough data yet');
  if (bias === 'RANGING') return none('Bias is ranging, so there is no directional setup');

  const long = bias === 'BULLISH';
  const wantedDir = long ? 'BULLISH' : 'BEARISH';
  const tol = params.confluenceAtr * atr;

  // Liquidity that was swept against the bias and then reclaimed (sell-side swept for longs, buy-side for shorts)
  const reclaimed = zones
    .filter((z) => z.status === 'SWEPT' && z.side === (long ? 'LOW' : 'HIGH') && z.sweptAt && candleTime - z.sweptAt <= params.reclaimMaxCandles * tfMs && (long ? z.level < price : z.level > price))
    .sort((a, b) => b.sweptAt - a.sweptAt);

  const pool = [
    ...fvgs.filter((f) => f.status !== 'FILLED' && f.direction === wantedDir).map((f) => ({ kind: 'FVG', top: f.top, bottom: f.bottom, key: f.key })),
    ...orderBlocks.filter((o) => o.status === 'UNMITIGATED' && o.direction === wantedDir).map((o) => ({ kind: 'ORDER_BLOCK', top: o.top, bottom: o.bottom, key: o.key })),
  ].filter((z) => (long ? z.bottom <= price : z.top >= price)); // zone must be at / behind current price

  const pdMatches = pd && ((long && pd.zone === 'DISCOUNT') || (!long && pd.zone === 'PREMIUM'));
  const scored = pool.map((z) => {
    const reclaim = reclaimed.find((r) => r.level >= z.bottom - tol && r.level <= z.top + tol) || null;
    const other = pool.find((o) => o.kind !== z.kind && o.bottom <= z.top && o.top >= z.bottom) || null;
    const score = (reclaim ? 2 : 0) + (other ? 1 : 0) + (pdMatches ? 1 : 0);
    const distance = long ? Math.max(0, price - z.top) : Math.max(0, z.bottom - price);
    return { z, reclaim, other, score, distance };
  });

  const eligible = params.requireSweep ? scored.filter((s) => s.reclaim) : scored;
  if (!eligible.length) {
    return none(params.requireSweep
      ? 'No unmitigated FVG / order block overlapping a reclaimed liquidity level yet'
      : 'No unmitigated FVG / order block in the bias direction');
  }
  eligible.sort((a, b) => b.score - a.score || a.distance - b.distance);
  const { z, reclaim, other, score } = eligible[0];

  const inside = long ? price <= z.top : price >= z.bottom;
  const entry = long ? Math.min(z.top, price) : Math.max(z.bottom, price);
  const buffer = params.slBufferAtr * atr;
  const base = reclaim ? (long ? Math.min(z.bottom, reclaim.level) : Math.max(z.top, reclaim.level)) : long ? z.bottom : z.top;
  const stopLoss = long ? base - buffer : base + buffer;
  if (long ? price <= stopLoss : price >= stopLoss) return none('Price is already beyond the invalidation level');

  // Targets: next untouched liquidity beyond entry, de-duplicated
  const gap = params.minTargetGapAtr * atr;
  const targets = zones
    .filter((t) => t.status === 'RESTING' && t.side === (long ? 'HIGH' : 'LOW') && (long ? t.level > entry + gap : t.level < entry - gap))
    .sort((a, b) => (long ? a.level - b.level : b.level - a.level));
  const kept = [];
  for (const t of targets) {
    const prev = kept[kept.length - 1];
    if (prev && Math.abs(t.level - prev.level) < params.dedupeLevelsAtr * atr) {
      if ((t.strength || 1) > (prev.strength || 1)) kept[kept.length - 1] = t;
    } else kept.push(t);
  }
  if (!kept.length) return none('No untouched liquidity target in the bias direction');
  const tp1 = kept[0];
  const tp2 = kept[1] || null;

  const risk = Math.abs(entry - stopLoss);
  const rr = (t) => (t ? Number((Math.abs(t.level - entry) / risk).toFixed(2)) : null);
  const rr1 = rr(tp1);
  const rr2 = rr(tp2);

  const warnings = [];
  if (risk < 0.5 * atr) warnings.push('Stop is tighter than 0.5 ATR, so normal volatility can hit it');
  if (rr1 < 1) warnings.push('First target pays less than the risk (R:R below 1)');
  if (!tp2) warnings.push('Only one untouched liquidity target found');
  if (!reclaim) warnings.push('No reclaimed-liquidity confluence for this zone');
  if (pd && !pdMatches && pd.zone !== 'EQUILIBRIUM') warnings.push(`Entry area is in ${pd.zone.toLowerCase()}, against the usual ${long ? 'discount' : 'premium'} preference`);

  const zoneName = z.kind === 'FVG' ? `${long ? 'bullish' : 'bearish'} FVG` : `${long ? 'bullish' : 'bearish'} order block`;
  const reason = [
    `${long ? 'Bullish' : 'Bearish'} bias${biasEvent ? ` (${biasEvent.type === 'BOS' ? 'BOS' : 'CHoCH'})` : ''}.`,
    reclaim ? `${long ? 'Sell-side' : 'Buy-side'} liquidity at ${roundPrice(reclaim.level)} was swept and reclaimed.` : null,
    `Entry zone: ${zoneName} ${roundPrice(z.bottom)}-${roundPrice(z.top)}${other ? ` (overlaps a ${other.kind === 'FVG' ? 'FVG' : 'order block'})` : ''}.`,
    `Targets: untouched liquidity at ${roundPrice(tp1.level)}${tp2 ? ` and ${roundPrice(tp2.level)}` : ''}.`,
  ].filter(Boolean).join(' ');

  return {
    status: inside ? 'READY' : 'WAITING', // READY = price already inside the entry zone, WAITING = needs a pullback
    direction: long ? 'LONG' : 'SHORT',
    entry: roundPrice(entry),
    stopLoss: roundPrice(stopLoss),
    takeProfit1: roundPrice(tp1.level),
    takeProfit2: tp2 ? roundPrice(tp2.level) : null,
    risk: roundPrice(risk),
    rr1,
    rr2,
    confidence: score,
    reason,
    warnings,
    entryZone: { kind: z.kind, top: z.top, bottom: z.bottom, key: z.key },
    reclaimedLevel: reclaim ? { type: reclaim.type, level: reclaim.level, sweptAt: reclaim.sweptAt } : undefined,
    candleTime,
  };
}

module.exports = { buildSetup };
