const { Schema, model } = require('mongoose');

// Latest Suggested Setup per symbol + timeframe (open question #4: we store one per timeframe).
const SetupSchema = new Schema(
  {
    exchange: String,
    symbol: String,
    timeframe: String,
    status: { type: String, enum: ['READY', 'WAITING', 'NONE'] }, // READY = price is inside entry zone
    direction: { type: String, enum: ['LONG', 'SHORT', null] },
    entry: Number,
    stopLoss: Number,
    takeProfit1: Number,
    takeProfit2: Number,
    risk: Number,
    rr1: Number,
    rr2: Number,
    confidence: Number,
    reason: String,
    warnings: [String],
    entryZone: { kind: String, top: Number, bottom: Number, key: String },
    reclaimedLevel: { type: { type: String }, level: Number, sweptAt: Number },
    candleTime: Number,
  },
  { versionKey: false, timestamps: { createdAt: false, updatedAt: 'updatedAt' } }
);
SetupSchema.index({ exchange: 1, symbol: 1, timeframe: 1 }, { unique: true });

module.exports = model('Setup', SetupSchema);
