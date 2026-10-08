const { Schema, model } = require('mongoose');

// One row = one closed candle. Raw per-venue rows (exchange = binance | bybit) and, when several venues are enabled,
// the merged rows the engine reads (exchange = 'combined').
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
    takerVolumeBase: Number, // volume (base) that the taker-buy numbers refer to; 0 for venues without order-flow data
    sources: [String], // combined candles only: which venues contributed
  },
  { versionKey: false }
);
CandleSchema.index({ exchange: 1, symbol: 1, timeframe: 1, openTime: 1 }, { unique: true });

module.exports = model('Candle', CandleSchema);
