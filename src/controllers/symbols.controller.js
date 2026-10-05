// One handler per dashboard panel (+ the full dashboard in one call).
const asyncHandler = require('../middleware/asyncHandler');
const { clampInt } = require('../middleware/validate');
const panels = require('../services/panelService');
const { getMtf } = require('../services/mtfService');
const { getIndicators } = require('../services/indicatorService');
const { getDashboard } = require('../services/dashboardService');

exports.dashboard = asyncHandler(async (req, res) => {
  res.json(await getDashboard(req.symbol, req.tf, { includeOrderBook: req.query.orderbook !== 'false' }));
});
exports.bias = asyncHandler(async (req, res) => res.json(await panels.getBias(req.symbol, req.tf)));
exports.setup = asyncHandler(async (req, res) => {
  // ?tf=all returns one setup per timeframe
  if (req.query.tf === 'all') return res.json({ symbol: req.symbol, setups: await panels.getSetupsAllTimeframes(req.symbol) });
  return res.json(await panels.getSetup(req.symbol, req.tf));
});
exports.liquidity = asyncHandler(async (req, res) => res.json(await panels.getLiquidity(req.symbol, req.tf)));
exports.fvg = asyncHandler(async (req, res) => res.json(await panels.getFvgs(req.symbol, req.tf, { status: req.query.status })));
exports.orderBlocks = asyncHandler(async (req, res) => res.json(await panels.getOrderBlocks(req.symbol, req.tf)));
exports.stats = asyncHandler(async (req, res) => res.json(await panels.getStats(req.symbol)));
exports.events = asyncHandler(async (req, res) => {
  const type = ['BOS', 'CHOCH', 'SWEEP'].includes(String(req.query.type).toUpperCase()) ? String(req.query.type).toUpperCase() : undefined;
  res.json(await panels.getEvents(req.symbol, req.tf, { limit: clampInt(req.query.limit, 50, 1, 200), type }));
});
exports.mtf = asyncHandler(async (req, res) => res.json(await getMtf(req.symbol)));
exports.indicators = asyncHandler(async (req, res) => {
  res.json(await getIndicators(req.symbol, req.tf, { includeOrderBook: req.query.orderbook !== 'false' }));
});
exports.candles = asyncHandler(async (req, res) => res.json(await panels.getCandles(req.symbol, req.tf, clampInt(req.query.limit, 200, 1, 1000))));
