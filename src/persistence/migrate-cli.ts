import { MongoClient } from 'mongodb';
import { loadConfig } from '../config/index.js';
import { runMigrations, MIGRATIONS } from './mongo/migrations.js';

/** Usage: npm run migrate            -> apply pending migrations
 *         npm run migrate -- status  -> list applied/pending */
async function main() {
  const { config, secrets } = loadConfig();
  const client = new MongoClient(secrets.mongoUri, { serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  const db = client.db(config.db.name);
  try {
    if (process.argv.includes('status')) {
      const applied = await db.collection('schema_migrations').find({}).toArray();
      const set = new Set(applied.map((a) => a._id as unknown as number));
      for (const m of MIGRATIONS) console.log(`${set.has(m.version) ? '[x]' : '[ ]'} ${m.version} ${m.name}`);
    } else {
      const ran = await runMigrations(db);
      console.log(ran.length ? `Applied migrations: ${ran.join(', ')}` : 'Database is up to date');
    }
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
