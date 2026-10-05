const router = require('express').Router();
const c = require('../controllers/watchlist.controller');
const { validateSymbol } = require('../middleware/validate');

router.get('/', c.list); // sidebar: bias tag per coin
router.post('/', validateSymbol, c.add); // body: { "symbol": "BTCUSDT" }
router.delete('/:symbol', validateSymbol, c.remove);

module.exports = router;
