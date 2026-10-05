const { Schema, model } = require('mongoose');

// Latest summary per symbol + timeframe. Feeds the bias banner, MTF panel and watchlist.
const PointSchema = new Schema({ price: Number, openTime: Number, broken: Boolean }, { _id: false });

const StructureStateSchema = new Schema(
  {
    exchange: String,
    symbol: String,
    timeframe: String,
    bias: { type: String, enum: ['BULLISH', 'BEARISH', 'RANGING'], default: 'RANGING' },
    biasEvent: { type: { type: String }, direction: String, level: Number, time: Number, message: String },
    lastSwingHigh: PointSchema,
    lastSwingLow: PointSchema,
    atr: Number,
    lastPrice: Number,
    lastCandleTime: Number,
  },
  { versionKey: false, timestamps: { createdAt: false, updatedAt: 'updatedAt' } }
);
StructureStateSchema.index({ exchange: 1, symbol: 1, timeframe: 1 }, { unique: true });

module.exports = model('StructureState', StructureStateSchema);
