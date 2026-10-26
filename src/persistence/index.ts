import type { AppConfig, Secrets } from '../config/index.js';
import type { Repositories } from './ports.js';
import { createMemoryRepositories } from './memory.js';

export * from './ports.js';

export async function createRepositories(config: AppConfig, secrets: Secrets): Promise<Repositories> {
  if (config.db.driver === 'memory') {
    if (config.app.mode === 'LIVE') throw new Error('db.driver=memory is not allowed with LIVE mode (no durable audit trail)');
    return createMemoryRepositories();
  }
  const { createMongoRepositories } = await import('./mongo/index.js');
  return createMongoRepositories({
    uri: secrets.mongoUri,
    dbName: config.db.name,
    maxPoolSize: config.db.maxPoolSize,
    transactions: config.db.transactions,
    writeConcern: config.db.writeConcern,
  });
}
