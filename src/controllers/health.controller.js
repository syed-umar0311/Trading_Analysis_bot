const mongoose = require('mongoose');
const config = require('../config');
const ingestion = require('../services/candleIngestion');

const DB_STATES = ['disconnected', 'connected', 'connecting', 'disconnecting'];

exports.health = (req, res) => {
  res.json({
    status: mongoose.connection.readyState === 1 ? 'ok' : 'degraded',
    uptimeSeconds: Math.round(process.uptime()),
    database: DB_STATES[mongoose.connection.readyState] || 'unknown',
    exchange: config.exchange,
    timeframes: config.timeframes,
    primaryTimeframe: config.primaryTimeframe,
    activeSymbols: ingestion.activeSymbols(),
    alertsEnabled: config.alerts.enabled,
  });
};
