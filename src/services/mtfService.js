// MULTI-TIMEFRAME: bias of every timeframe side by side. Disagreement is flagged, never hidden.
const config = require('../config');
const { TF_MS, sortTimeframes } = require('../utils/timeframes');
const { StructureState } = require('../models');

const label = (b) => (b ? b.toLowerCase() : 'unknown');

// Pure function (also used by the watchlist) -> easy to test.
function computeMtf(frames) {
  const known = frames.filter((f) => f.bias !== 'UNKNOWN');
  if (known.length < 2) return { frames, alignment: known.length ? 'SINGLE' : 'NO_DATA', higherTimeframe: known[0]?.timeframe || null, higherBias: known[0]?.bias || null, conflicts: [], summary: known.length ? `Only ${known[0].timeframe} is active` : 'No data yet' };

  const htf = known[known.length - 1]; // highest timeframe
  const directional = known.filter((f) => f.bias !== 'RANGING');
  const conflicts = htf.bias === 'RANGING' ? [] : known.filter((f) => f !== htf && f.bias !== 'RANGING' && f.bias !== htf.bias).map((f) => f.timeframe);

  let alignment = 'MIXED';
  if (conflicts.length) alignment = 'CONFLICT';
  else if (directional.length === known.length && new Set(directional.map((f) => f.bias)).size === 1) alignment = 'ALIGNED';

  const summary = conflicts.length
    ? `${conflicts.join(', ')} ${conflicts.length > 1 ? 'are' : 'is'} ${label(known.find((f) => f.timeframe === conflicts[0]).bias)} inside a ${label(htf.bias)} ${htf.timeframe}`
    : alignment === 'ALIGNED'
      ? `All timeframes are ${label(htf.bias)}`
      : `Timeframes are mixed (some ranging); ${htf.timeframe} is ${label(htf.bias)}`;

  return { frames, alignment, higherTimeframe: htf.timeframe, higherBias: htf.bias, conflicts, summary };
}

function toFrame(tf, s) {
  if (!s) return { timeframe: tf, bias: 'UNKNOWN' };
  return { timeframe: tf, bias: s.bias, event: s.biasEvent ? { type: s.biasEvent.type, direction: s.biasEvent.direction, level: s.biasEvent.level, time: s.biasEvent.time } : null, lastPrice: s.lastPrice, atr: s.atr, lastCandleTime: s.lastCandleTime };
}

async function getMtf(symbol) {
  const states = await StructureState.find({ exchange: config.exchange, symbol, timeframe: { $in: config.timeframes } }).lean();
  const frames = sortTimeframes(config.timeframes).map((tf) => toFrame(tf, states.find((s) => s.timeframe === tf)));
  return { symbol, ...computeMtf(frames) };
}

module.exports = { computeMtf, toFrame, getMtf, TF_MS };
