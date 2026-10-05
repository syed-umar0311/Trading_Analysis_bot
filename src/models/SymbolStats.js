const { Schema, model } = require('mongoose');

// Stat strip: funding, open interest, long/short ratio, previous-day high/low.
const SymbolStatsSchema = new Schema(
  {
    exchange: String,
    symbol: String,
    markPrice: Number,
    indexPrice: Number,
    fundingRate: Number,
    nextFundingTime: Number,
    openInterest: Number, // contracts (base asset)
    openInterestUsd: Number,
    oiChangePct: { h1: Number, h4: Number, h24: Number },
    longShort: { ratio: Number, longAccount: Number, shortAccount: Number, timestamp: Number },
    pdh: Number,
    pdl: Number,
    pdDayOpenTime: Number, // open time of the "previous day" candle (UTC)
  },
  { versionKey: false, timestamps: { createdAt: false, updatedAt: 'updatedAt' } }
);
SymbolStatsSchema.index({ exchange: 1, symbol: 1 }, { unique: true });

module.exports = model('SymbolStats', SymbolStatsSchema);
