const { Schema, model } = require('mongoose');

const WatchlistItemSchema = new Schema(
  {
    exchange: { type: String, default: 'binance' },
    symbol: { type: String, required: true },
    active: { type: Boolean, default: true },
    ready: { type: Boolean, default: false }, // true once history is loaded and the engine is warm
    addedAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);
WatchlistItemSchema.index({ exchange: 1, symbol: 1 }, { unique: true });

module.exports = model('WatchlistItem', WatchlistItemSchema);
