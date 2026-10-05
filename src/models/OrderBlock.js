const { Schema, model } = require('mongoose');

// Last opposing candle before an impulsive move that broke structure.
const OrderBlockSchema = new Schema(
  {
    key: { type: String, required: true },
    exchange: String,
    symbol: String,
    timeframe: String,
    direction: { type: String, enum: ['BULLISH', 'BEARISH'] }, // BULLISH = demand zone
    top: Number,
    bottom: Number,
    status: { type: String, enum: ['UNMITIGATED', 'MITIGATED'], default: 'UNMITIGATED' },
    createdAt: Number, // openTime of the candle that confirmed the structure break
    candleTime: Number, // openTime of the order-block candle itself
    impulseAtr: Number, // size of the impulse in ATR units
    mitigatedAt: Number,
  },
  { versionKey: false }
);
OrderBlockSchema.index({ exchange: 1, symbol: 1, timeframe: 1, key: 1 }, { unique: true });
OrderBlockSchema.index({ symbol: 1, timeframe: 1, status: 1 });

module.exports = model('OrderBlock', OrderBlockSchema);
