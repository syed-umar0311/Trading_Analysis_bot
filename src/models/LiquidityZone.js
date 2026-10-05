const { Schema, model } = require('mongoose');

// A price level where stop orders are likely resting.
// status: RESTING (untouched) | SWEPT (wick through, closed back) | BROKEN (candle closed beyond it)
const LiquidityZoneSchema = new Schema(
  {
    key: { type: String, required: true },
    exchange: String,
    symbol: String,
    timeframe: String,
    type: {
      type: String,
      enum: ['SWING_HIGH', 'SWING_LOW', 'EQUAL_HIGH', 'EQUAL_LOW', 'PDH', 'PDL', 'SESSION_HIGH', 'SESSION_LOW'],
    },
    side: { type: String, enum: ['HIGH', 'LOW'] }, // HIGH = buy-side liquidity above price
    level: Number,
    status: { type: String, enum: ['RESTING', 'SWEPT', 'BROKEN'], default: 'RESTING' },
    label: String,
    strength: { type: Number, default: 1 }, // >1 for equal highs/lows (number of touches)
    createdAt: Number, // openTime of the candle where the level formed / became active
    sweptAt: Number,
    brokenAt: Number,
  },
  { versionKey: false }
);
LiquidityZoneSchema.index({ exchange: 1, symbol: 1, timeframe: 1, key: 1 }, { unique: true });
LiquidityZoneSchema.index({ symbol: 1, timeframe: 1, status: 1 });

module.exports = model('LiquidityZone', LiquidityZoneSchema);
