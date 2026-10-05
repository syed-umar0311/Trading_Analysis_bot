# Liquidity Bias Dashboard - Backend

Node.js + Express + MongoDB (Mongoose). Implements the Scope of Work: candle ingestion, the Structure & Signal Engine
(swings, BOS/CHoCH, liquidity + sweeps, FVG, order blocks, equal highs/lows), Suggested Setup, multi-timeframe,
watchlist, stat strip and the Phase 3 indicators that Binance data alone can provide.

## Quick start

```bash
npm install
cp .env.example .env        # edit MONGODB_URI if needed
npm test                    # engine + schema tests (no MongoDB / internet needed)
npm start                   # API on http://localhost:4000
```
Requires Node 20+ and a running MongoDB. On first start the server seeds the watchlist (`DEFAULT_SYMBOLS`),
downloads `BACKFILL_CANDLES` candles per symbol/timeframe from Binance, warms the engines, then switches to live WebSocket candles.
Check `GET /api/health` and `GET /api/watchlist` (`ready: true` when a coin is warmed up).

## Phases = just config

| Phase | `.env` |
|---|---|
| 1 - Core engine (15m only) | `TIMEFRAMES=15m` |
| 2 - Decision UI backend | `TIMEFRAMES=5m,15m,1h,4h` |
| 3 - Expansion | indicators endpoint (CVD, volume profile, sessions, order book) is already included |

Open questions from the SOW are settings, not code changes: watchlist size (any Binance USDT perpetual via
`POST /api/watchlist`), timeframes (`TIMEFRAMES`), alerts (`ALERTS_ENABLED` + Telegram vars),
one setup vs one per timeframe (both returned: `suggestedSetup` and `setupsByTimeframe`).

## API

| Method & path | Panel |
|---|---|
| `GET /api/health` | service status |
| `GET /api/watchlist` | Watchlist sidebar (bias tag per coin, MTF alignment, setup status) |
| `POST /api/watchlist` `{ "symbol": "SOLUSDT" }` | add a coin (warms up in background, returns 202) |
| `DELETE /api/watchlist/:symbol` | remove a coin |
| `GET /api/symbols?search=sol` | searchable list of Binance USDT perpetuals |
| `GET /api/symbols/:symbol/dashboard?tf=15m` | **everything below in one response** (`&orderbook=false` skips the live depth call) |
| `GET /api/symbols/:symbol/bias?tf=` | Bias banner |
| `GET /api/symbols/:symbol/setup?tf=` or `tf=all` | Suggested Setup |
| `GET /api/symbols/:symbol/liquidity?tf=` | Liquidity above / below + recently swept |
| `GET /api/symbols/:symbol/fvg?tf=&status=unfilled\|filled` | Fair Value Gaps |
| `GET /api/symbols/:symbol/order-blocks?tf=` | Order blocks |
| `GET /api/symbols/:symbol/stats` | Stat strip (funding, OI, OI change, long/short, PDH/PDL) |
| `GET /api/symbols/:symbol/events?tf=&type=BOS\|CHOCH\|SWEEP&limit=` | Structure timeline |
| `GET /api/symbols/:symbol/mtf` | Multi-timeframe with disagreement flag |
| `GET /api/symbols/:symbol/indicators?tf=` | ATR, premium/discount (OTE), equal levels, CVD, volume profile, sessions, OI trend, order-book imbalance |
| `GET /api/symbols/:symbol/candles?tf=&limit=` | stored candles |

## Where each SOW task lives (one file per task)

```
src/engine/            pure logic, no database, fully unit-testable
  atr.js               ATR volatility
  swings.js            fractal swing detection (+ optional ZigZag min-move filter)
  structure.js         BOS / CHoCH / ranging state machine
  liquidity.js         liquidity zones, sweeps, equal highs/lows
  fvg.js               Fair Value Gaps
  orderBlocks.js       order blocks + mitigation
  premiumDiscount.js   premium / discount / OTE
  setup.js             Suggested Setup (entry, SL, TP1/2, R:R, reason, warnings)
  cvd.js               cumulative volume delta + divergence
  volumeProfile.js     volume profile, POC, value area
  sessions.js          Asian / London / New York highs & lows
  StructureEngine.js   orchestrator: process(candle) -> delta, incremental, per symbol+timeframe
src/exchanges/         binanceClient.js (REST) - binanceWs.js (live klines) - index.js (add Bybit/OKX here)
src/services/          candleIngestion - engineRunner - persistence - statsService - liquiditySources
                       alertService - mtfService - orderBookService - indicatorService
                       panelService - dashboardService - watchlistService
src/models/            one Mongoose model per collection
src/controllers|routes|middleware|config|utils
tests/                 engine.test.js (15 tests on 50 real BTC candles) - schema.test.js
```

## How the engine runs

* **Incremental**: `StructureEngine.process(candle)` handles one CLOSED candle and returns only what changed. Live candles never trigger a full recompute.
* **Warm-up**: on start (or when a coin is added) stored candles are replayed once through a fresh engine, derived collections are rebuilt, and writes are idempotent (deterministic keys).
* **Ordering**: a per-engine queue guarantees candles are processed in order; duplicates are ignored. After a WebSocket reconnect missed candles are fetched and replayed (`catchUp`).
* **Zone lifecycle**: liquidity `RESTING -> SWEPT` (wick through, close back) or `BROKEN` (close beyond). FVG `UNFILLED -> PARTIAL -> FILLED`. Order block `UNMITIGATED -> MITIGATED`.
* **Suggested Setup** follows the SOW rule: entry must be an unmitigated FVG/order block overlapping a *reclaimed* liquidity level. When none qualifies the setup is `NONE` with the reason. Set `SETUP_REQUIRE_SWEEP=false` to also propose zones without sweep confluence (they carry a warning).

## Honest limitations

* **Tested here**: the engine on real candles, all schemas, the HTTP validation layer. **Not tested here**: MongoDB writes, live Binance REST/WebSocket (the build sandbox has no MongoDB or Binance access). Run it once against a real Mongo + internet and watch the logs.
* Binance moved USD-M futures sockets to `/public`, `/market`, `/private`. Klines are on `/market` (default `BINANCE_WS_URL`). If Binance changes routes again, only that env var / `binanceWs.js` changes.
* Not included: **Bybit / OKX** (add adapters in `src/exchanges/` with the same functions as `binanceClient.js`), **liquidation heatmap** (needs a paid aggregator), authentication / rate limiting on the API.
* "Current price" in distances is Binance mark price refreshed every `STATS_POLL_MS` (default 60 s), falling back to the last closed candle.
* Sessions are UTC windows (Asia 00-08, London 07-16, New York 13-22) editable in `src/config/index.js`.
* Trading heuristics, not advice: signals are rule-based approximations of price-action concepts.
