const asyncHandler = require('../middleware/asyncHandler');
const watchlist = require('../services/watchlistService');

exports.list = asyncHandler(async (req, res) => {
  res.json({ watchlist: await watchlist.summary() });
});

exports.add = asyncHandler(async (req, res) => {
  const item = await watchlist.add(req.symbol);
  res.status(202).json({ message: 'Added. History is loading in the background; poll GET /api/watchlist until ready=true.', item });
});

exports.remove = asyncHandler(async (req, res) => {
  res.json(await watchlist.remove(req.symbol));
});

exports.search = asyncHandler(async (req, res) => {
  res.json({ symbols: await watchlist.searchSymbols(String(req.query.search || '')) });
});
