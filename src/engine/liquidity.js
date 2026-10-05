// LIQUIDITY ZONES & SWEEPS
//  RESTING -> SWEPT  : a wick goes through the level but the candle closes back on the original side
//  RESTING -> BROKEN : a candle closes beyond the level (liquidity taken by a real break)
const { fmtTime } = require('../utils/helpers');

function makeSwingZone(swing) {
  const isHigh = swing.type === 'HIGH';
  return {
    key: `${isHigh ? 'SWING_HIGH' : 'SWING_LOW'}:${swing.openTime}`,
    type: isHigh ? 'SWING_HIGH' : 'SWING_LOW',
    side: isHigh ? 'HIGH' : 'LOW',
    level: swing.price,
    status: 'RESTING',
    strength: 1,
    createdAt: swing.openTime,
    label: isHigh ? 'Swing high' : 'Swing low',
  };
}

// Checks one candle against one zone. Returns 'SWEPT' | 'BROKEN' | null.
function testZone(zone, candle) {
  if (zone.status !== 'RESTING' || candle.openTime <= zone.createdAt) return null;
  if (zone.side === 'HIGH') {
    if (candle.close > zone.level) return 'BROKEN';
    if (candle.high > zone.level) return 'SWEPT';
  } else {
    if (candle.close < zone.level) return 'BROKEN';
    if (candle.low < zone.level) return 'SWEPT';
  }
  return null;
}

function applyResult(zone, result, candle) {
  zone.status = result;
  if (result === 'SWEPT') zone.sweptAt = candle.openTime;
  else zone.brokenAt = candle.openTime;
}

function sweepEvent(zone, candle) {
  const high = zone.side === 'HIGH';
  return {
    type: 'SWEEP',
    direction: high ? 'BEARISH' : 'BULLISH', // price usually reverses after taking liquidity
    side: zone.side,
    level: zone.level,
    price: candle.close,
    time: candle.openTime,
    zoneType: zone.type,
    message: `${high ? 'Buy-side' : 'Sell-side'} liquidity swept at ${zone.level} (${zone.label || zone.type}) at ${fmtTime(candle.openTime)}`,
  };
}

// Run every resting zone against the newest candle.
function updateZones(zones, candle) {
  const changed = [];
  const events = [];
  for (const zone of zones.values()) {
    const result = testZone(zone, candle);
    if (!result) continue;
    applyResult(zone, result, candle);
    changed.push(zone);
    if (result === 'SWEPT') events.push(sweepEvent(zone, candle));
  }
  return { changed, events };
}

// EQUAL HIGHS / LOWS: several resting swings at almost the same price = a stronger magnet.
// Called when a new swing zone appears. Returns the equal-level zone to upsert (or null).
function detectEqualLevel(zones, newZone, atr, tolAtr) {
  if (!atr || !tolAtr) return null;
  const tol = atr * tolAtr;
  const members = [...zones.values()].filter(
    (z) => z.type === newZone.type && z.status === 'RESTING' && Math.abs(z.level - newZone.level) <= tol
  );
  if (members.length < 2) return null;
  const isHigh = newZone.side === 'HIGH';
  const earliest = Math.min(...members.map((m) => m.createdAt));
  const level = isHigh ? Math.max(...members.map((m) => m.level)) : Math.min(...members.map((m) => m.level));
  const key = `${isHigh ? 'EQUAL_HIGH' : 'EQUAL_LOW'}:${earliest}`;
  const existing = zones.get(key);
  return {
    key,
    type: isHigh ? 'EQUAL_HIGH' : 'EQUAL_LOW',
    side: newZone.side,
    level,
    status: existing?.status || 'RESTING',
    strength: members.length,
    createdAt: existing?.createdAt || Math.max(...members.map((m) => m.createdAt)),
    label: `Equal ${isHigh ? 'highs' : 'lows'} x${members.length}`,
  };
}

module.exports = { makeSwingZone, testZone, applyResult, sweepEvent, updateZones, detectEqualLevel };
