const logger = require('../utils/logger');

function notFound(req, res) {
  res.status(404).json({ error: 'Not found', path: req.originalUrl });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  if (status >= 500) logger.error(err);
  res.status(status).json({ error: err.message || 'Internal server error', details: err.details });
}

module.exports = { notFound, errorHandler };
