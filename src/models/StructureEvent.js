const { Schema, model } = require('mongoose');

// Timeline log: BOS / CHOCH / SWEEP.
const StructureEventSchema = new Schema(
  {
    key: { type: String, required: true },
    exchange: String,
    symbol: String,
    timeframe: String,
    type: { type: String, enum: ['BOS', 'CHOCH', 'SWEEP'] },
    direction: { type: String, enum: ['BULLISH', 'BEARISH'] }, // for SWEEP: the expected reaction
    side: { type: String, enum: ['HIGH', 'LOW', null] }, // SWEEP only: which side was swept
    level: Number,
    price: Number, // close of the candle that produced the event
    time: Number, // openTime of that candle
    zoneType: String,
    message: String,
    alerted: { type: Boolean, default: false },
  },
  { versionKey: false }
);
StructureEventSchema.index({ exchange: 1, symbol: 1, timeframe: 1, key: 1 }, { unique: true });
StructureEventSchema.index({ symbol: 1, timeframe: 1, time: -1 });

module.exports = model('StructureEvent', StructureEventSchema);
