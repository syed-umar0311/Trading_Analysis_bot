const router = require('express').Router();

router.use('/health', require('./health.routes'));
router.use('/watchlist', require('./watchlist.routes'));
router.use('/symbols', require('./symbols.routes'));

module.exports = router;
