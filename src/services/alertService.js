// OPTIONAL alerts (open question #3). Disabled unless ALERTS_ENABLED=true.
// Rule: a CHoCH that follows a liquidity sweep in the same direction within N candles.
//   sell-side sweep (low) then bullish CHoCH   |   buy-side sweep (high) then bearish CHoCH
const config = require('../config');
const logger = require('../utils/logger');
const { StructureEvent } = require('../models');

async function sendTelegram(text) {
  const { telegramBotToken: token, telegramChatId: chat } = config.alerts;
  if (!token || !chat) {
    logger.warn('Alerts enabled but TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing');
    return false;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}`);
  return true;
}

async function handleEvents(engine, events) {
  if (!config.alerts.enabled) return;
  const window = config.alerts.sweepLookbackCandles * engine.tfMs;
  for (const ev of events.filter((e) => e.type === 'CHOCH')) {
    const sweep = engine.recentEvents.find((r) => r.type === 'SWEEP' && r.direction === ev.direction && ev.time - r.time >= 0 && ev.time - r.time <= window);
    if (!sweep) continue;
    const dir = ev.direction === 'BULLISH' ? 'Bullish' : 'Bearish';
    const text = `${engine.symbol} ${engine.timeframe}: ${dir} CHoCH after a ${sweep.side === 'LOW' ? 'sell-side' : 'buy-side'} liquidity sweep.\n${ev.message}`;
    try {
      if (await sendTelegram(text)) await StructureEvent.updateOne({ exchange: engine.exchange, symbol: engine.symbol, timeframe: engine.timeframe, key: ev.key }, { $set: { alerted: true } });
    } catch (err) {
      logger.warn('Telegram alert failed:', err.message);
    }
  }
}

module.exports = { handleEvents, sendTelegram };
