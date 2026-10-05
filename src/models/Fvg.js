const { Schema, model } = require('mongoose');

// Fair Value Gap: 3-candle imbalance. UNFILLED -> PARTIAL (price entered) -> FILLED (price traded through).
const FvgSchema = new Schema(
  {
    key: { type: String, required: true },
    exchange: String,
    symbol: String,
    timeframe: String,
    direction: { type: String, enum: ['BULLISH', 'BEARISH'] },
    top: Number,
    bottom: Number,
    size: Number,
    status: { type: String, enum: ['UNFILLED', 'PARTIAL', 'FILLED'], default: 'UNFILLED' },
    createdAt: Number, // openTime of candle 3 (when the gap became known)
    middleTime: Number, // openTime of candle 2 (the impulse candle)
    filledAt: Number,
  },
  { versionKey: false }
);
FvgSchema.index({ exchange: 1, symbol: 1, timeframe: 1, key: 1 }, { unique: true });
FvgSchema.index({ symbol: 1, timeframe: 1, status: 1 });

module.exports = model('Fvg', FvgSchema);
