require('dotenv').config();
const { connectDb, disconnectDb } = require('../src/config/db');
const models = require('../src/models');

const VALID = /^[A-Z0-9]{3,20}$/;
(async () => {
  const apply = process.argv.includes('--apply');
  await connectDb();
  for (const [name, Model] of Object.entries(models)) {
    if (!Model?.schema?.paths?.symbol) continue;
    const bad = (await Model.distinct('symbol')).filter((s) => !VALID.test(s));
    if (!bad.length) continue;
    const filter = { symbol: { $in: bad } };
    if (apply) console.log(`${name}: deleted ${(await Model.deleteMany(filter)).deletedCount} docs for`, bad);
    else console.log(`${name}: would delete ${await Model.countDocuments(filter)} docs for`, bad);
  }
  if (!apply) console.log('Dry run. Re-run with --apply to delete.');
  await disconnectDb();
})().catch((e) => { console.error(e); process.exit(1); });