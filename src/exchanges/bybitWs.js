// Live candle stream manager for Bybit v5 (USDT linear perpetuals). Same public API as binanceWs.js:
//   start(symbols, timeframes) | add(symbol, timeframes) | remove(symbol, timeframes) | stop()
//   events: 'candle' (closed candles only), 'reconnected'
//
// Differences from Binance that this file handles:
//  - one socket, streams are subscribed with {"op":"subscribe","args":["kline.15.BTCUSDT", ...]} AFTER it opens
//  - the server expects {"op":"ping"} about every 20 s; we also treat a long silence as a dead socket and reconnect
//  - a kline frame is a live snapshot; `confirm: true` marks the final tick of the candle
//  - the symbol is only in the topic ("kline.15.BTCUSDT"), not in the payload
const WebSocket = require('ws');
const EventEmitter = require('events');
const config = require('../config');
const logger = require('../utils/logger');
const { chunk } = require('../utils/helpers');
const { toInterval, normalizeWsKline } = require('./bybitClient');

const SUBSCRIBE_BATCH = 20; // args per subscribe message (futures have no args limit, this just keeps frames small)
const topicName = (symbol, tf) => `kline.${toInterval(tf)}.${symbol}`;

class Connection {
  constructor(manager, topics) {
    this.manager = manager;
    this.topics = new Set(topics);
    this.ws = null;
    this.attempt = 0;
    this.closedByUs = false;
    this.heartbeat = null;
    this.reconnectTimer = null;
    this.lastMessageAt = 0;
  }

  connect() {
    if (this.closedByUs) return;
    const ws = new WebSocket(config.bybit.wsUrl);
    this.ws = ws;

    ws.on('open', () => {
      logger.info(`Bybit WS connected (${this.topics.size} streams)`);
      const wasReconnect = this.attempt > 0;
      this.attempt = 0;
      this.lastMessageAt = Date.now();
      this._subscribe([...this.topics]);
      this._startHeartbeat();
      if (wasReconnect) this.manager.emit('reconnected');
    });

    ws.on('message', (raw) => {
      this.lastMessageAt = Date.now();
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.op) { // subscribe / pong acknowledgements
          if (msg.success === false) logger.warn(`Bybit WS ${msg.op} failed: ${msg.ret_msg || 'unknown reason'}`);
          return;
        }
        if (typeof msg.topic !== 'string' || !msg.topic.startsWith('kline.') || !Array.isArray(msg.data)) return;
        const symbol = msg.topic.split('.')[2];
        for (const k of msg.data) {
          if (k.confirm) this.manager.emit('candle', normalizeWsKline(k, symbol)); // confirm = candle is closed
        }
      } catch (err) {
        logger.warn('Bybit WS parse error', err.message);
      }
    });

    ws.on('error', (err) => logger.warn('Bybit WS error', err.message));

    ws.on('close', () => {
      this._stopHeartbeat();
      if (this.closedByUs) return;
      this.attempt += 1;
      const delay = Math.min(30000, 1000 * 2 ** Math.min(this.attempt, 5));
      logger.warn(`Bybit WS closed, reconnecting in ${delay}ms`);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    const every = config.bybit.wsPingMs;
    this.heartbeat = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      // Pongs and kline pushes both count as traffic. Three silent intervals = the socket is dead: force a reconnect.
      if (Date.now() - this.lastMessageAt > every * 3) {
        logger.warn('Bybit WS silent for too long, reconnecting');
        this.ws.terminate();
        return;
      }
      this.ws.send(JSON.stringify({ op: 'ping' }));
    }, every);
  }

  _stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  _send(op, args) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ op, args }));
  }

  _subscribe(topics) {
    for (const group of chunk(topics, SUBSCRIBE_BATCH)) this._send('subscribe', group);
  }

  close() {
    this.closedByUs = true;
    this._stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}

class BybitWsManager extends EventEmitter {
  constructor() {
    super();
    this.connections = [];
  }

  // Start streams for these symbols/timeframes (call once at boot).
  start(symbols, timeframes) {
    const topics = symbols.flatMap((s) => timeframes.map((tf) => topicName(s, tf)));
    for (const group of chunk(topics, config.bybit.wsMaxStreamsPerConnection)) {
      const c = new Connection(this, group);
      this.connections.push(c);
      c.connect();
    }
  }

  // Add streams while running (user adds a coin to the watchlist).
  add(symbol, timeframes) {
    for (const tf of timeframes) {
      const name = topicName(symbol, tf);
      if (this.connections.some((c) => c.topics.has(name))) continue;
      const target = this.connections.find((c) => c.topics.size < config.bybit.wsMaxStreamsPerConnection);
      if (target) {
        target.topics.add(name);
        target._subscribe([name]); // no-op while the socket is still connecting; it subscribes everything on open
      } else {
        const c = new Connection(this, [name]);
        this.connections.push(c);
        c.connect();
      }
    }
  }

  remove(symbol, timeframes) {
    for (const tf of timeframes) {
      const name = topicName(symbol, tf);
      for (const c of this.connections) {
        if (c.topics.delete(name)) c._send('unsubscribe', [name]);
      }
    }
  }

  stop() {
    this.connections.forEach((c) => c.close());
    this.connections = [];
  }
}

module.exports = new BybitWsManager();
