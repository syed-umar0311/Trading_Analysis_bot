// The Structure & Signal Engine for ONE symbol + timeframe.
// Feed it closed candles one at a time with process(candle). Each call updates its state
// incrementally (never recomputes history) and returns a "delta": exactly what changed.
const config = require('../config');
const { tfToMs } = require('../utils/timeframes');
const { fmtTime } = require('../utils/helpers');
const { calcAtr } = require('./atr');
const { detectPivot, passesMinMove } = require('./swings');
const { createState, updateStructure } = require('./structure');
const { makeSwingZone, updateZones, detectEqualLevel, testZone, applyResult, sweepEvent } = require('./liquidity');
const { detectFvg, updateFvgs } = require('./fvg');
const { detectOrderBlock, updateOrderBlocks } = require('./orderBlocks');

const eventKey = (e) => [e.type, e.time, e.level, e.direction, e.zoneType || ''].join(':');

class StructureEngine {
  constructor({ exchange = 'binance', symbol, timeframe, params = config.engine }) {
    this.exchange = exchange;
    this.symbol = symbol;
    this.timeframe = timeframe;
    this.tfMs = tfToMs(timeframe);
    this.params = params;

    this.state = createState();
    this.window = []; // most recent closed candles
    this.zones = new Map();
    this.fvgs = new Map();
    this.obs = new Map();
    this.recentEvents = []; // last events, used by alerts
    this.atr = null;
    this.lastCandleTime = null;
  }

  _finalizeEvent(e) {
    const ev = { side: null, zoneType: null, ...e };
    ev.key = eventKey(ev);
    this.recentEvents.push({ type: ev.type, direction: ev.direction, side: ev.side, time: ev.time });
    if (this.recentEvents.length > 50) this.recentEvents.shift();
    return ev;
  }

  process(candle) {
    if (this.lastCandleTime !== null && candle.openTime <= this.lastCandleTime) return null; // already seen
    const p = this.params;
    const delta = { candle, swings: [], zones: [], fvgs: [], orderBlocks: [], events: [], state: null };

    this.window.push(candle);
    if (this.window.length > p.windowSize) this.window.shift();
    this.lastCandleTime = candle.openTime;
    const atr = calcAtr(this.window, p.atrPeriod);
    this.atr = atr;

    // 1) existing liquidity zones: swept or broken by this candle?
    const zr = updateZones(this.zones, candle);
    delta.zones.push(...zr.changed);
    zr.events.forEach((e) => delta.events.push(this._finalizeEvent(e)));

    // 2) existing FVGs filled / order blocks mitigated?
    delta.fvgs.push(...updateFvgs(this.fvgs, candle));
    delta.orderBlocks.push(...updateOrderBlocks(this.obs, candle));

    // 3) newly confirmed swing (the candle N positions back)
    for (const sw of detectPivot(this.window, p.swingN)) {
      if (!passesMinMove(sw, this.state.lastSwing, atr, p.minSwingMoveAtr)) continue;
      this.state.lastSwing = sw;
      delta.swings.push(sw);
      const point = { price: sw.price, openTime: sw.openTime, broken: false };
      if (sw.type === 'HIGH') this.state.lastSwingHigh = point;
      else this.state.lastSwingLow = point;

      const zone = makeSwingZone(sw);
      this.zones.set(zone.key, zone);
      delta.zones.push(zone);
      const eq = detectEqualLevel(this.zones, zone, atr, p.equalTolAtr);
      if (eq) {
        this.zones.set(eq.key, eq);
        delta.zones.push(eq);
      }
    }

    // 4) market structure: BOS / CHoCH
    for (const e of updateStructure(this.state, candle, { rangingAfterCandles: p.rangingAfterCandles })) {
      const bull = e.direction === 'BULLISH';
      const label = e.type === 'BOS' ? 'BOS' : 'CHoCH';
      const message = `${label} ${bull ? 'up' : 'down'}: closed ${candle.close} ${bull ? 'above' : 'below'} ${e.level} at ${fmtTime(candle.openTime)}`;
      const ev = this._finalizeEvent({ type: e.type, direction: e.direction, level: e.level, price: candle.close, time: candle.openTime, message });
      delta.events.push(ev);
      this.state.biasEvent = { type: e.type, direction: e.direction, level: e.level, time: candle.openTime, message };

      const ob = detectOrderBlock(this.window, e, atr, { impulseAtr: p.impulseAtr, lookback: p.obLookback });
      if (ob && !this.obs.has(ob.key)) {
        this.obs.set(ob.key, ob);
        delta.orderBlocks.push(ob);
      }
    }

    // 5) newly formed FVG (this candle is candle 3)
    const fvg = detectFvg(this.window, atr, p.fvgMinAtr);
    if (fvg && !this.fvgs.has(fvg.key)) {
      this.fvgs.set(fvg.key, fvg);
      delta.fvgs.push(fvg);
    }

    this._prune(candle.openTime);
    delta.state = this.stateSnapshot();
    return delta;
  }

  // PDH/PDL and session highs/lows come from outside (they are not formed by this timeframe's swings).
  // spec: { key, type, side, level, label, activeFrom }  activeFrom = ms timestamp the level becomes live.
  addExternalZone(spec) {
    if (this.zones.has(spec.key)) return null;
    const zone = {
      key: spec.key, type: spec.type, side: spec.side, level: spec.level, label: spec.label,
      status: 'RESTING', strength: 1, createdAt: spec.activeFrom - 1,
    };
    const delta = { zones: [zone], events: [] };
    // price may already have touched it since it became active: replay our window against it
    for (const c of this.window) {
      const result = testZone(zone, c);
      if (!result) continue;
      applyResult(zone, result, c);
      if (result === 'SWEPT') delta.events.push(this._finalizeEvent(sweepEvent(zone, c)));
      break;
    }
    this.zones.set(zone.key, zone);
    return delta;
  }

  stateSnapshot() {
    const last = this.window[this.window.length - 1];
    return {
      exchange: this.exchange,
      symbol: this.symbol,
      timeframe: this.timeframe,
      bias: this.state.bias,
      biasEvent: this.state.biasEvent,
      lastSwingHigh: this.state.lastSwingHigh,
      lastSwingLow: this.state.lastSwingLow,
      atr: this.atr,
      lastPrice: last ? last.close : null,
      lastCandleTime: this.lastCandleTime,
    };
  }

  // Everything the setup builder / alerts need, straight from memory.
  snapshot() {
    return {
      ...this.stateSnapshot(),
      tfMs: this.tfMs,
      zones: [...this.zones.values()],
      fvgs: [...this.fvgs.values()],
      orderBlocks: [...this.obs.values()],
      recentEvents: this.recentEvents,
    };
  }

  // Finished items older than pruneAfterCandles leave memory (they remain in MongoDB).
  _prune(now) {
    const cutoff = now - this.params.pruneAfterCandles * this.tfMs;
    for (const [k, z] of this.zones) if (z.status !== 'RESTING' && (z.sweptAt || z.brokenAt) < cutoff) this.zones.delete(k);
    for (const [k, f] of this.fvgs) if (f.status === 'FILLED' && f.filledAt < cutoff) this.fvgs.delete(k);
    for (const [k, o] of this.obs) if (o.status === 'MITIGATED' && o.mitigatedAt < cutoff) this.obs.delete(k);
  }
}

module.exports = StructureEngine;
