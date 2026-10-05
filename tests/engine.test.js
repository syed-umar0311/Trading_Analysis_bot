// Run: npm test   (no MongoDB or internet needed - tests the pure engine only)
// Fixture = 50 real BTC 1h candles (03 Oct 08:00 -> 05 Oct 09:00 UTC). OHLC is real, volume fields are placeholders.
const assert = require('node:assert/strict');
const path = require('path');
const { normalizeKline } = require('../src/exchanges/binanceClient');
const StructureEngine = require('../src/engine/StructureEngine');
const { buildSetup } = require('../src/engine/setup');
const { premiumDiscount } = require('../src/engine/premiumDiscount');
const { computeCvd } = require('../src/engine/cvd');
const { volumeProfile } = require('../src/engine/volumeProfile');
const { latestSessionLevels } = require('../src/engine/sessions');
const config = require('../src/config');

const raw = require(path.join(__dirname, 'fixtures/btc_1h_sample.json'));
const candles = raw.map((k) => normalizeKline(k, 'BTCUSDT', '1h'));
let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`  ok  ${name}`); };

const engine = new StructureEngine({ symbol: 'BTCUSDT', timeframe: '1h' });
const deltas = candles.map((c) => engine.process(c));
const snap = engine.snapshot();
const allEvents = deltas.flatMap((d) => d.events);

test('normalizes Binance kline strings into numbers', () => {
  assert.equal(candles.length, 50);
  assert.equal(typeof candles[0].high, 'number');
  assert.equal(candles[0].high, 84644.47);
});

test('same candle fed twice is ignored (idempotent)', () => {
  assert.equal(engine.process(candles[49]), null);
});

test('swing highs/lows detected (N=2)', () => {
  const highs = deltas.flatMap((d) => d.swings).filter((s) => s.type === 'HIGH').map((s) => s.price);
  assert.ok(highs.includes(86999.11));
  assert.ok(highs.includes(85470));
  const lows = deltas.flatMap((d) => d.swings).filter((s) => s.type === 'LOW').map((s) => s.price);
  assert.ok(lows.includes(85412));
});

test('market structure: bias is BULLISH after two BOS up', () => {
  assert.equal(snap.bias, 'BULLISH');
  const bos = allEvents.filter((e) => e.type === 'BOS' && e.direction === 'BULLISH').map((e) => e.level);
  assert.ok(bos.includes(85037.63));
  assert.ok(bos.includes(85470));
  assert.equal(allEvents.filter((e) => e.type === 'CHOCH').length, 0);
});

test('liquidity: 86,999.11 is resting above, 85,412 resting below', () => {
  const resting = snap.zones.filter((z) => z.status === 'RESTING');
  assert.ok(resting.some((z) => z.side === 'HIGH' && z.level === 86999.11));
  assert.ok(resting.some((z) => z.side === 'LOW' && z.level === 85412));
});

test('sweeps: wick above 85,470 closing back below is logged as SWEEP', () => {
  const sweeps = allEvents.filter((e) => e.type === 'SWEEP' && e.side === 'HIGH').map((e) => e.level);
  assert.ok(sweeps.includes(85470));
});

test('FVG: unfilled bullish gap 85,361.99 - 85,396.32 found', () => {
  const f = snap.fvgs.find((x) => x.direction === 'BULLISH' && x.bottom === 85361.99 && x.top === 85396.32);
  assert.ok(f, 'gap missing');
  assert.equal(f.status, 'UNFILLED');
});

test('order blocks are created on structure breaks', () => {
  assert.ok(deltas.flatMap((d) => d.orderBlocks).length >= 1);
});

test('ATR is positive', () => assert.ok(snap.atr > 0));

test('premium/discount for last price', () => {
  const pd = premiumDiscount({ swingHigh: snap.lastSwingHigh.price, swingLow: snap.lastSwingLow.price, price: snap.lastPrice, bias: snap.bias });
  assert.ok(pd && ['PREMIUM', 'DISCOUNT', 'EQUILIBRIUM'].includes(pd.zone));
});

test('suggested setup never returns nonsense (valid levels when present)', () => {
  const pd = premiumDiscount({ swingHigh: snap.lastSwingHigh.price, swingLow: snap.lastSwingLow.price, price: snap.lastPrice, bias: snap.bias });
  for (const requireSweep of [true, false]) {
    const s = buildSetup({ ...snap, price: snap.lastPrice, candleTime: snap.lastCandleTime, premiumDiscount: pd }, { ...config.setup, requireSweep });
    assert.ok(['READY', 'WAITING', 'NONE'].includes(s.status));
    if (s.status !== 'NONE') {
      assert.equal(s.direction, 'LONG');
      assert.ok(s.stopLoss < s.entry && s.entry < s.takeProfit1, 'long: SL < entry < TP1');
      assert.ok(s.rr1 > 0);
    }
  }
});

test('setup math on a hand-built scenario matches the worked example', () => {
  const ctx = {
    bias: 'BULLISH', price: 100, atr: 2, tfMs: 3_600_000, candleTime: 1_000_000_000, biasEvent: { type: 'BOS' },
    zones: [
      { type: 'SWING_LOW', side: 'LOW', level: 95, status: 'SWEPT', sweptAt: 999_000_000, key: 'a' },
      { type: 'SWING_HIGH', side: 'HIGH', level: 103, status: 'RESTING', key: 'b' },
      { type: 'SWING_HIGH', side: 'HIGH', level: 108, status: 'RESTING', key: 'c' },
    ],
    fvgs: [{ key: 'f', direction: 'BULLISH', bottom: 96, top: 97, status: 'UNFILLED' }],
    orderBlocks: [],
    premiumDiscount: null,
  };
  const s = buildSetup(ctx, { ...config.setup, slBufferAtr: 0.25 });
  assert.equal(s.status, 'WAITING');
  assert.equal(s.entry, 97);
  assert.equal(s.stopLoss, 94.5); // min(96, 95) - 0.25*2
  assert.equal(s.takeProfit1, 103);
  assert.equal(s.takeProfit2, 108);
  assert.equal(s.rr1, 2.4);
  assert.equal(s.rr2, 4.4);
});

test('CHoCH flips bias when price closes below the last swing low', () => {
  const e = new StructureEngine({ symbol: 'X', timeframe: '1h' });
  candles.forEach((c) => e.process(c));
  const last = candles[candles.length - 1];
  const crash = { ...last, openTime: last.openTime + 3_600_000, closeTime: last.closeTime + 3_600_000, open: 85900, high: 85950, low: 85300, close: 85350 };
  const d = e.process(crash);
  assert.ok(d.events.some((x) => x.type === 'CHOCH' && x.direction === 'BEARISH' && x.level === 85412));
  assert.equal(e.snapshot().bias, 'BEARISH');
});

test('external zone (PDH) is created and swept retroactively', () => {
  const e = new StructureEngine({ symbol: 'X', timeframe: '1h' });
  candles.forEach((c) => e.process(c));
  const d = e.addExternalZone({ key: 'PDH:test', type: 'PDH', side: 'HIGH', level: 86800, label: 'Previous day high', activeFrom: candles[40].openTime });
  // candle 41 (05 Oct 01:00) wicked to 86,999.11 but closed at 86,615.31, back below 86,800 => SWEPT, not BROKEN
  assert.equal(d.zones[0].status, 'SWEPT');
  assert.ok(d.events.some((x) => x.type === 'SWEEP' && x.zoneType === 'PDH' && x.level === 86800));
});

test('CVD, volume profile, session levels run', () => {
  const withVol = candles.map((c, i) => ({ ...c, volume: 100 + i, takerBuyBase: 50 + (i % 7) * 5 }));
  assert.equal(computeCvd(withVol).series.length, 50);
  const vp = volumeProfile(withVol);
  assert.ok(vp.poc >= vp.rangeLow && vp.poc <= vp.rangeHigh);
  const lv = latestSessionLevels(candles, config.sessions, candles[49].closeTime + 1);
  assert.ok(lv.length >= 1 && lv[0].high >= lv[0].low);
});

console.log(`\n${passed} tests passed`);
