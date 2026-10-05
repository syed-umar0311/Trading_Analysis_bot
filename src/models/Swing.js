const { Schema, model } = require('mongoose');

// Confirmed swing highs / lows (fractal pivots).
const SwingSchema = new Schema(
  {
    exchange: String,
    symbol: String,
    timeframe: String,
    type: { type: String, enum: ['HIGH', 'LOW'] },
    price: Number,
    openTime: Number, // candle that formed the pivot
    confirmedAt: Number, // candle on which it became confirmed (N candles later)
  },
  { versionKey: false }
);
SwingSchema.index({ exchange: 1, symbol: 1, timeframe: 1, type: 1, openTime: 1 }, { unique: true });

module.exports = model('Swing', SwingSchema);
