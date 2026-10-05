const config = require('../config');
const { HttpError } = require('../utils/helpers');

// :symbol must look like BTCUSDT. We upper-case it so /btcusdt works too.
function validateSymbol(req, res, next) {
  const symbol = String(req.params.symbol || req.body?.symbol || '').toUpperCase();
  if (!/^[A-Z0-9]{3,20}$/.test(symbol)) return next(new HttpError(400, 'Invalid symbol'));
  req.symbol = symbol;
  return next();
}

// ?tf=15m must be one of the timeframes this server runs. Defaults to the primary one.
function validateTimeframe(req, res, next) {
  const tf = req.query.tf || config.primaryTimeframe;
  if (!config.timeframes.includes(tf)) {
    return next(new HttpError(400, `Invalid tf. Enabled timeframes: ${config.timeframes.join(', ')}`));
  }
  req.tf = tf;
  return next();
}

const clampInt = (v, def, min, max) => {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(Math.max(n, min), max);
};

module.exports = { validateSymbol, validateTimeframe, clampInt };
