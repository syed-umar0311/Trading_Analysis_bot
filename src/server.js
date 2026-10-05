// Entry point: DB -> HTTP API -> background ingestion (history, live candles, stats polling).
const config = require('./config');
const logger = require('./utils/logger');
const { connectDb, disconnectDb } = require('./config/db');
const app = require('./app');
const watchlist = require('./services/watchlistService');
const ingestion = require('./services/candleIngestion');
const statsService = require('./services/statsService');
const liquiditySources = require('./services/liquiditySources');

async function main() {
  await connectDb();
  require('./services/retention').start();
  await watchlist.seedDefaults();

  const server = app.listen(config.port, () => logger.info(`API listening on :${config.port}`));

  // The API is up immediately; warm-up (history download + replay) continues in the background.
  const symbols = await watchlist.activeSymbols();
  ingestion
    .start(symbols)
    .then(() => {
      statsService.startPolling(() => ingestion.activeSymbols());
      liquiditySources.startPolling(() => ingestion.activeSymbols());
      logger.info('Live ingestion running');
    })
    .catch((err) => logger.error('Ingestion failed to start:', err));

  const shutdown = async (signal) => {
    logger.info(`${signal} received, shutting down`);
    statsService.stopPolling();
    liquiditySources.stopPolling();
    ingestion.stop();
    server.close();
    await disconnectDb().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('Fatal startup error:', err);
  process.exit(1);
});
