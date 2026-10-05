// Offline check: every document the engine produces must satisfy its Mongoose schema (no MongoDB needed).
const assert = require('node:assert/strict');
const path = require('path');
const M = require('../src/models');
const { normalizeKline } = require('../src/exchanges/binanceClient');
const StructureEngine = require('../src/engine/StructureEngine');
const { buildSetup } = require('../src/engine/setup');
const { premiumDiscount } = require('../src/engine/premiumDiscount');
const config = require('../src/config');

const candles = require(path.join(__dirname, 'fixtures/btc_1h_sample.json')).map((k) => normalizeKline(k, 'BTCUSDT', '1h'));
const scope = { exchange: 'binance', symbol: 'BTCUSDT', timeframe: '1h' };
const engine = new StructureEngine({ symbol: 'BTCUSDT', timeframe: '1h' });
const deltas = candles.map((c) => engine.process(c));
engine.addExternalZone({ key: 'PDH:1', type: 'PDH', side: 'HIGH', level: 86800, label: 'Previous day high', activeFrom: candles[40].openTime });
const all = (k) => deltas.flatMap((d) => d[k]);

let checked = 0;
const check = (Model, docs, label) => {
  for (const d of docs) {
    const err = new Model({ ...d, ...scope }).validateSync();
    assert.equal(err, undefined, `${label} invalid: ${err && err.message} -> ${JSON.stringify(d)}`);
    checked += 1;
  }
  console.log(`  ok  ${label}: ${docs.length} docs valid`);
};

check(M.Candle, candles, 'Candle');
check(M.Swing, all('swings'), 'Swing');
check(M.LiquidityZone, engine.snapshot().zones, 'LiquidityZone');
check(M.Fvg, engine.snapshot().fvgs, 'Fvg');
check(M.OrderBlock, engine.snapshot().orderBlocks, 'OrderBlock');
check(M.StructureEvent, all('events'), 'StructureEvent');
check(M.StructureState, [engine.stateSnapshot()], 'StructureState');

const snap = engine.snapshot();
const pd = premiumDiscount({ swingHigh: snap.lastSwingHigh.price, swingLow: snap.lastSwingLow.price, price: snap.lastPrice, bias: snap.bias });
const none = buildSetup({ ...snap, price: snap.lastPrice, candleTime: snap.lastCandleTime, premiumDiscount: pd }, config.setup);
const ready = buildSetup({
  bias: 'BULLISH', price: 100, atr: 2, tfMs: 3_600_000, candleTime: 1e9, biasEvent: { type: 'BOS' },
  zones: [{ type: 'SWING_LOW', side: 'LOW', level: 95, status: 'SWEPT', sweptAt: 999_000_000, key: 'a' }, { type: 'SWING_HIGH', side: 'HIGH', level: 103, status: 'RESTING', key: 'b' }],
  fvgs: [{ key: 'f', direction: 'BULLISH', bottom: 96, top: 97, status: 'UNFILLED' }], orderBlocks: [], premiumDiscount: null,
}, config.setup);
check(M.Setup, [none, ready], 'Setup (NONE + READY/WAITING with reclaimedLevel)');
check(M.SymbolStats, [{ fundingRate: 0.0001, openInterest: 1, oiChangePct: { h1: 1, h4: 2, h24: 3 }, longShort: { ratio: 1.2, longAccount: 0.55, shortAccount: 0.45, timestamp: 1 }, pdh: 1, pdl: 1 }], 'SymbolStats');
check(M.WatchlistItem, [{ symbol: 'BTCUSDT' }], 'WatchlistItem');
console.log(`\n${checked} documents validated against their schemas`);
