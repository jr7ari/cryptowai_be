/**
 * Composition root: config -> persistence -> integrations -> market data -> venues -> engine ->
 * learning -> HTTP API. Graceful shutdown on SIGINT/SIGTERM; fatal errors engage the kill switch.
 */
import { loadConfig, parseMap } from './config/index.js';
import { createRepositories } from './persistence/index.js';
import { createExchange } from './integrations/factory.js';
import { DeribitReference } from './integrations/deribit/reference.js';
import { LiveMarketData } from './marketdata/live.js';
import { PaperVenue } from './execution/paper.js';
import { Engine, LeaseHeldError } from './engine/engine.js';
import { ModelRegistry } from './model/registry.js';
import { LearningEngine } from './learning/engine.js';
import { Alerts } from './monitoring/alerts.js';
import { buildServer } from './api/server.js';
import { systemClock } from './lib/clock.js';
import { logger } from './lib/logger.js';

async function main() {
  const { config, secrets, sources } = loadConfig();
  logger.info({ sources, profile: config.app.profile, symbols: config.app.symbols, db: config.db.driver }, 'configuration loaded');
  const clock = systemClock;
  const repos = await createRepositories(config, secrets);
  const alerts = new Alerts(repos, clock, secrets.alertWebhookUrl, config.alerts.minLevel);

  const ex = createExchange(config, secrets, clock);
  logger.info({ exchange: ex.label, symbols: config.app.symbols, live: !!ex.liveVenue }, `connected exchange: ${ex.label}`);
  const rest = ex.client;
  const socket = ex.socket;
  const deribit = config.reference.deribitEnabled ? new DeribitReference(config.reference.deribitBaseUrl) : undefined;
  const underlyingMap = parseMap(config.app.underlyingMap);
  const market = new LiveMarketData(
    {
      symbols: config.app.symbols,
      timeframes: config.app.timeframes,
      decisionTf: config.app.decisionTimeframe,
      historyBars: config.app.historyBars,
      underlyingMap,
      referenceEnabled: config.reference.deribitEnabled,
      referenceRefreshSec: config.reference.refreshSec,
      persistChainEveryMs: 15 * 60_000,
      currentPricesPath: config.app.exchange === 'coindcx' ? config.coindcx.currentPricesPath : undefined,
    },
    rest,
    repos,
    clock,
    socket,
    deribit,
  );
  const reverse = Object.fromEntries(Object.entries(underlyingMap).map(([k, v]) => [v, k]));
  const underlyingOf = (inst: string) => (config.app.symbols.includes(inst) ? inst : reverse[inst.split('-')[0]] ?? config.app.symbols[0]);
  const paperVenue = new PaperVenue(config.paper, market, clock, underlyingOf, true);
  const liveVenue = ex.liveVenue;
  if (!liveVenue) logger.warn(`${ex.credentialsHint} not set: LIVE mode unavailable on ${ex.label} (PAPER only)`);

  const registry = new ModelRegistry(repos, clock);
  const engine = new Engine({ config, secrets, repos, market, paperVenue, liveVenue, clock, alerts, registry });
  const learning = new LearningEngine(config, repos, registry, clock, alerts, rest);

  const app = await buildServer({ config, secrets, repos, engine, learning, registry, alerts, market, exchange: rest, exchangeInfo: { id: ex.id, label: ex.label, marginCurrency: ex.marginCurrency, baseUrls: ex.baseUrls, credentialsHint: ex.credentialsHint } });
  const listenOpts = { port: config.app.http.port, host: config.app.http.host, exclusive: true as const };
  const listenDeadline = Date.now() + 8_000;
  for (;;) {
    try {
      await app.listen(listenOpts);
      break;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'EADDRINUSE' || Date.now() >= listenDeadline) {
        if (err.code === 'EADDRINUSE') {
          logger.fatal({ port: listenOpts.port }, 'port already in use — another backend is running. Stop the other `npm run dev` and retry.');
          process.exit(1);
        }
        throw e;
      }
      logger.warn({ port: listenOpts.port }, 'port busy (previous tsx process still exiting); retrying');
      await clock.sleep(250);
    }
  }
  logger.info({ port: config.app.http.port }, 'HTTP API listening');

  try {
    await engine.start({ leaseWaitMs: 20_000 });
  } catch (e) {
    if (e instanceof LeaseHeldError) {
      logger.fatal(e.message);
      await app.close();
      await repos.close();
      process.exit(1);
    }
    throw e;
  }
  learning.start();

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    logger.warn({ sig }, 'shutting down');
    learning.stop();
    await engine.stop();
    await app.close();
    await repos.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGBREAK', () => void shutdown('SIGBREAK'));
  process.on('unhandledRejection', (e) => {
    logger.error({ err: (e as Error)?.stack ?? String(e) }, 'unhandled rejection');
    void alerts.raise('error', 'UNHANDLED_REJECTION', String((e as Error)?.message ?? e));
  });
  process.on('uncaughtException', async (e) => {
    logger.fatal({ err: e.stack }, 'uncaught exception: engaging kill switch');
    try {
      await engine.killSwitch.engage('INTERNAL_ERROR', e.message, 'system', false);
    } finally {
      await shutdown('uncaughtException');
    }
  });
}

main().catch((e) => {
  logger.fatal({ err: (e as Error).stack }, 'fatal startup error');
  process.exit(1);
});
