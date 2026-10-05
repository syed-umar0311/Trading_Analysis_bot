const router = require('express').Router();
const c = require('../controllers/symbols.controller');
const wl = require('../controllers/watchlist.controller');
const { validateSymbol, validateTimeframe } = require('../middleware/validate');

router.get('/', wl.search); // GET /api/symbols?search=sol  -> searchable list of Binance USDT perpetuals

const sym = [validateSymbol];
const symTf = [validateSymbol, validateTimeframe];

router.get('/:symbol/dashboard', symTf, c.dashboard); // everything in one call
router.get('/:symbol/bias', symTf, c.bias); // bias banner
// /setup?tf=all returns one setup per timeframe, otherwise the usual ?tf= validation applies
const setupTf = (req, res, next) => (req.query.tf === 'all' ? next() : validateTimeframe(req, res, next));
router.get('/:symbol/setup', validateSymbol, setupTf, c.setup);
router.get('/:symbol/liquidity', symTf, c.liquidity); // liquidity above / below
router.get('/:symbol/fvg', symTf, c.fvg); // fair value gaps
router.get('/:symbol/order-blocks', symTf, c.orderBlocks);
router.get('/:symbol/stats', sym, c.stats); // stat strip
router.get('/:symbol/events', symTf, c.events); // structure timeline
router.get('/:symbol/mtf', sym, c.mtf); // multi-timeframe
router.get('/:symbol/indicators', symTf, c.indicators); // ATR, CVD, volume profile, OB imbalance...
router.get('/:symbol/candles', symTf, c.candles);

module.exports = router;
