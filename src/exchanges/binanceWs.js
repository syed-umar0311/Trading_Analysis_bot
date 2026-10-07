// Live candle stream manager for Binance USD-M Futures.
// Binance split futures sockets into /public, /market and /private. Kline streams live on /market,
// so BINANCE_WS_URL defaults to wss://fstream.binance.com/market and we connect to <url>/stream?streams=a/b/c
const WebSocket = require("ws");
const EventEmitter = require("events");
const config = require("../config");
const logger = require("../utils/logger");
const { chunk } = require("../utils/helpers");
const { normalizeWsKline } = require("./binanceClient");

const streamName = (symbol, tf) => `${symbol.toLowerCase()}@kline_${tf}`;

class Connection {
  constructor(manager, streams) {
    this.manager = manager;
    this.streams = new Set(streams);
    this.ws = null;
    this.attempt = 0;
    this.closedByUs = false;
    this.nextId = 1;
  }

  connect() {
    const url = `${config.binance.wsUrl}/stream?streams=${[...this.streams].join("/")}`;
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      logger.info(`WS connected (${this.streams.size} streams)`);
      const wasReconnect = this.attempt > 0;
      this.attempt = 0;
      if (wasReconnect) this.manager.emit("reconnected");
    });

    this.ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const k = msg?.data?.k;
        if (k && k.x) this.manager.emit("candle", normalizeWsKline(k)); // x = candle is closed
      } catch (err) {
        logger.warn("WS parse error", err.message);
      }
    });

    this.ws.on("unexpected-response", (req, res) => {
      let body = "";
      res.on("data", (d) => {
        if (body.length < 300) body += d;
      });
      res.on("end", () =>
        logger.warn(
          `WS handshake rejected (${res.statusCode}): ${body} | streams: ${[...this.streams].slice(0, 5).join(",")}${this.streams.size > 5 ? ",..." : ""}`,
        ),
      );
    });
    this.ws.on("error", (err) => logger.warn("WS error", err.message));
    this.ws.on("close", () => {
      if (this.closedByUs) return;
      this.attempt += 1;
      const delay = Math.min(30000, 1000 * 2 ** Math.min(this.attempt, 5));
      logger.warn(`WS closed, reconnecting in ${delay}ms`);
      setTimeout(() => this.connect(), delay);
    });
  }

  send(method, params) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method, params, id: this.nextId++ }));
    }
  }

  close() {
    this.closedByUs = true;
    this.ws?.close();
  }
}

class BinanceWsManager extends EventEmitter {
  constructor() {
    super();
    this.connections = [];
  }

  // Start streams for these symbols/timeframes (call once at boot).
  start(symbols, timeframes) {
    const streams = symbols.flatMap((s) =>
      timeframes.map((tf) => streamName(s, tf)),
    );
    for (const group of chunk(
      streams,
      config.binance.wsMaxStreamsPerConnection,
    )) {
      const c = new Connection(this, group);
      this.connections.push(c);
      c.connect();
    }
  }

  // Add streams while running (user adds a coin to the watchlist).
  add(symbol, timeframes) {
    for (const tf of timeframes) {
      const name = streamName(symbol, tf);
      if (this.connections.some((c) => c.streams.has(name))) continue;
      const target = this.connections.find(
        (c) => c.streams.size < config.binance.wsMaxStreamsPerConnection,
      );
      if (target) {
        target.streams.add(name);
        target.send("SUBSCRIBE", [name]);
      } else {
        const c = new Connection(this, [name]);
        this.connections.push(c);
        c.connect();
      }
    }
  }

  remove(symbol, timeframes) {
    for (const tf of timeframes) {
      const name = streamName(symbol, tf);
      for (const c of this.connections) {
        if (c.streams.delete(name)) c.send("UNSUBSCRIBE", [name]);
      }
    }
  }

  stop() {
    this.connections.forEach((c) => c.close());
    this.connections = [];
  }
}

module.exports = new BinanceWsManager();
