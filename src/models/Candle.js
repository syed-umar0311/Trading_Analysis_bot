const { Schema, model } = require('mongoose');

// One row = one closed candle. Raw market data, source of truth for the engine.
const CandleSchema = new Schema(
  {
    exchange: { type: String, required: true },
    symbol: { type: String, required: true },
    timeframe: { type: String, required: true },
    openTime: { type: Number, required: true }, // ms
    closeTime: { type: Number, required: true },
    open: Number,
    high: Number,
    low: Number,
    close: Number,
    volume: Number, // base asset (e.g. BTC)
    quoteVolume: Number,
    trades: Number,
    takerBuyBase: Number, // used for CVD
    takerBuyQuote: Number,
  },
  { versionKey: false }
);
CandleSchema.index({ exchange: 1, symbol: 1, timeframe: 1, openTime: 1 }, { unique: true });

module.exports = model('Candle', CandleSchema);
