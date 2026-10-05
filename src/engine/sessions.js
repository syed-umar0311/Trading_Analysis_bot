// SESSION LIQUIDITY: high / low of the most recent COMPLETED Asian, London and New York sessions (UTC).
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function latestSessionLevels(candles, sessions, nowMs = Date.now()) {
  const todayStart = Math.floor(nowMs / DAY) * DAY;
  const out = [];
  for (const [name, def] of Object.entries(sessions)) {
    for (let d = 0; d < 3; d += 1) {
      const dayStart = todayStart - d * DAY;
      const start = dayStart + def.start * HOUR;
      const end = dayStart + def.end * HOUR;
      if (end > nowMs) continue; // session not finished yet
      const inside = candles.filter((c) => c.openTime >= start && c.openTime < end);
      if (!inside.length) break;
      out.push({ name, start, end, high: Math.max(...inside.map((c) => c.high)), low: Math.min(...inside.map((c) => c.low)) });
      break;
    }
  }
  return out;
}

// Turn session levels into zone specs that StructureEngine.addExternalZone() understands.
function sessionZoneSpecs(levels) {
  return levels.flatMap((s) => [
    { key: `SESSION_HIGH:${s.name}:${s.start}`, type: 'SESSION_HIGH', side: 'HIGH', level: s.high, label: `${s.name} high`, activeFrom: s.end },
    { key: `SESSION_LOW:${s.name}:${s.start}`, type: 'SESSION_LOW', side: 'LOW', level: s.low, label: `${s.name} low`, activeFrom: s.end },
  ]);
}

module.exports = { latestSessionLevels, sessionZoneSpecs };
