// MERGE BUFFER: live closed candles arrive separately from each venue. Hold the first one until every expected
// venue has delivered the same bucket (flush immediately) or `graceMs` passed (flush with what we have).
// A candle that arrives AFTER its bucket was flushed is reported through onLate instead of being merged alone,
// because a single-venue version must never overwrite a stored multi-venue candle.
class MergeBuffer {
  constructor({ graceMs = 5000, onFlush, onLate = () => {}, onError = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, keepFlushed = 5000 }) {
    this.graceMs = graceMs;
    this.onFlush = onFlush;
    this.onLate = onLate;
    this.onError = onError;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.keepFlushed = keepFlushed;
    this.pending = new Map();
    this.flushed = new Set(); // insertion-ordered, trimmed to keepFlushed
  }

  static keyOf(c) { return `${c.symbol}|${c.timeframe}|${c.openTime}`; }

  add(candle, expectedVenues) {
    const key = MergeBuffer.keyOf(candle);
    if (this.flushed.has(key)) { this._safe(() => this.onLate(candle)); return; }
    let entry = this.pending.get(key);
    if (!entry) {
      entry = { candles: new Map(), expected: new Set(expectedVenues), timer: null };
      this.pending.set(key, entry);
    }
    entry.candles.set(candle.exchange, candle);
    if ([...entry.expected].every((v) => entry.candles.has(v))) this._flush(key);
    else if (!entry.timer) entry.timer = this.setTimer(() => this._flush(key), this.graceMs);
  }

  _flush(key) {
    const entry = this.pending.get(key);
    if (!entry) return;
    if (entry.timer) this.clearTimer(entry.timer);
    this.pending.delete(key);
    this.flushed.add(key);
    if (this.flushed.size > this.keepFlushed) this.flushed.delete(this.flushed.values().next().value);
    this._safe(() => this.onFlush([...entry.candles.values()]));
  }

  _safe(fn) {
    try {
      const r = fn();
      if (r && typeof r.catch === 'function') r.catch((e) => this.onError(e));
    } catch (e) { this.onError(e); }
  }

  // shutdown: drop timers without flushing (the DB is going away)
  clear() {
    for (const e of this.pending.values()) if (e.timer) this.clearTimer(e.timer);
    this.pending.clear();
  }
}

module.exports = MergeBuffer;
