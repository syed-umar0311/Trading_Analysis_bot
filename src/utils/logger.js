// Tiny logger, no dependency. Swap for pino/winston later if you want.
const stamp = () => new Date().toISOString();
const fmt = (level, args) => [`[${stamp()}] ${level}`, ...args];
module.exports = {
  info: (...a) => console.log(...fmt('INFO ', a)),
  warn: (...a) => console.warn(...fmt('WARN ', a)),
  error: (...a) => console.error(...fmt('ERROR', a)),
  debug: (...a) => process.env.DEBUG && console.log(...fmt('DEBUG', a)),
};
