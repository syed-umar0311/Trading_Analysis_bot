// Writes engine "deltas" to MongoDB. One bulkWrite per collection, upserts keyed by a deterministic key,
// so replaying the same candles twice never creates duplicates.
const { Swing, LiquidityZone, Fvg, OrderBlock, StructureEvent, StructureState } = require('../models');

const scope = (ctx) => ({ exchange: ctx.exchange, symbol: ctx.symbol, timeframe: ctx.timeframe });
const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

// Several deltas may touch the same item; the last version wins.
const mergeByKey = (lists, keyFn) => {
  const m = new Map();
  for (const list of lists) for (const item of list) m.set(keyFn(item), item);
  return [...m.values()];
};

const upserts = (ctx, docs, keyFn, filterFn) =>
  docs.map((d) => ({ updateOne: { filter: { ...scope(ctx), ...filterFn(d) }, update: { $set: { ...clean(d), ...scope(ctx) } }, upsert: true } }));

async function applyDeltas(ctx, deltas, { historical = false } = {}) {
  if (!deltas.length) return;
  const zones = mergeByKey(deltas.map((d) => d.zones || []), (z) => z.key);
  const fvgs = mergeByKey(deltas.map((d) => d.fvgs || []), (f) => f.key);
  const obs = mergeByKey(deltas.map((d) => d.orderBlocks || []), (o) => o.key);
  const events = mergeByKey(deltas.map((d) => d.events || []), (e) => e.key);
  const swings = mergeByKey(deltas.map((d) => d.swings || []), (s) => `${s.type}:${s.openTime}`);

  const jobs = [];
  if (zones.length) jobs.push(LiquidityZone.bulkWrite(upserts(ctx, zones, null, (z) => ({ key: z.key })), { ordered: false }));
  if (fvgs.length) jobs.push(Fvg.bulkWrite(upserts(ctx, fvgs, null, (f) => ({ key: f.key })), { ordered: false }));
  if (obs.length) jobs.push(OrderBlock.bulkWrite(upserts(ctx, obs, null, (o) => ({ key: o.key })), { ordered: false }));
  if (swings.length) jobs.push(Swing.bulkWrite(upserts(ctx, swings, null, (s) => ({ type: s.type, openTime: s.openTime })), { ordered: false }));
  if (events.length) {
    // `alerted` is only set when the event is first inserted. Historical replays never alert.
    const ops = events.map((e) => {
      const { alerted, ...rest } = e;
      return { updateOne: { filter: { ...scope(ctx), key: e.key }, update: { $set: { ...clean(rest), ...scope(ctx) }, $setOnInsert: { alerted: historical } }, upsert: true } };
    });
    jobs.push(StructureEvent.bulkWrite(ops, { ordered: false }));
  }
  const last = [...deltas].reverse().find((d) => d.state);
  if (last) jobs.push(StructureState.updateOne(scope(ctx), { $set: clean(last.state) }, { upsert: true }));
  await Promise.all(jobs);
}

async function clearDerived(ctx) {
  const s = scope(ctx);
  await Promise.all([Swing, LiquidityZone, Fvg, OrderBlock, StructureEvent].map((m) => m.deleteMany(s)));
}

module.exports = { applyDeltas, clearDerived, clean, scope };
