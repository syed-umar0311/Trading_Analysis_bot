const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function retry(fn, { retries = 3, baseMs = 500, shouldRetry = () => true } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt > retries || !shouldRetry(err)) throw err;
      await sleep(baseMs * 2 ** (attempt - 1));
    }
  }
}

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

// Rounds a price sensibly regardless of its size (BTC 85,000 vs a 0.00001 coin).
const roundPrice = (n) => {
  if (n === null || n === undefined || Number.isNaN(n)) return n;
  const abs = Math.abs(n);
  const dp = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 6 : 8;
  return Number(n.toFixed(dp));
};

const pctDistance = (level, price) => ((level - price) / price) * 100;
const fmtTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

module.exports = { sleep, retry, chunk, roundPrice, pctDistance, fmtTime, HttpError };
