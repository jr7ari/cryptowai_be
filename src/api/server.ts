/**
 * HTTP API (Fastify) for the dashboard and operators.
 *  - GET endpoints are read-only.
 *  - Mutations require `X-Operator-Token` (constant-time compared with OPERATOR_TOKEN). LIVE-related
 *    actions ALWAYS require it; engaging the kill switch is always allowed (fail-safe direction).
 *  - /api/stream is a Server-Sent-Events feed for live dashboard updates.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { timingSafeEqual } from 'node:crypto';
import type { AppConfig, Secrets } from '../config/index.js';
import type { Repositories } from '../persistence/ports.js';
import type { Engine } from '../engine/engine.js';
import { LIVE_CONFIRM_PHRASE } from '../engine/engine.js';
import type { LearningEngine } from '../learning/engine.js';
import type { ModelRegistry } from '../model/registry.js';
import type { Alerts } from '../monitoring/alerts.js';
import { metrics } from '../monitoring/metrics.js';
import { tradeMetrics, breakdown, curveMetrics } from '../learning/metrics.js';
import { stripLedger } from '../persistence/ledger.js';
import { interpretFeatures, extractFeatures } from '../regime/features.js';
import { classify } from '../regime/classifier.js';
import { forecastVolatility } from '../strategies/selector.js';
import { alphaDrift, writeAlphaFeatures } from '../signals/alpha.js';
import { STRATEGY_INFO } from '../strategies/builders.js';
import type { MarketView } from '../marketdata/view.js';
import type { Mode, Timeframe, StrategyName } from '../domain/types.js';
import { STRATEGIES, REGIMES } from '../domain/types.js';
import { BacktestJobs } from './backtest-jobs.js';
import { registerExchangeRoutes } from './exchange-routes.js';
import { positionExchange, type FuturesExchangeClient } from '../integrations/exchange.js';
import { uuid } from '../lib/ids.js';
import { childLogger } from '../lib/logger.js';

const log = childLogger('api');

export interface ApiDeps {
  config: AppConfig;
  secrets: Secrets;
  repos: Repositories;
  engine: Engine;
  learning: LearningEngine;
  registry: ModelRegistry;
  alerts: Alerts;
  market: MarketView & { socketStatus?: () => unknown; stats?: (s: string) => { change24h?: number; volume24h?: number; ts: number } | null };
  exchange?: FuturesExchangeClient;
  /** which exchange this process is connected to (chosen at startup) */
  exchangeInfo?: ExchangeInfo;
}

export interface ExchangeInfo {
  id: 'coindcx' | 'delta';
  label: string;
  marginCurrency: string;
  baseUrls: Record<string, string>;
  credentialsHint: string;
}

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const asMode = (m: unknown): Mode | undefined => (m === 'LIVE' || m === 'PAPER' ? m : undefined);
const num = (v: unknown, d: number) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : d);

export async function buildServer(d: ApiDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });
  await app.register(cors, {
    origin: d.config.app.http.corsOrigins,
    credentials: false,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept', 'X-Operator-Token', 'X-Operator-Name'],
  });
  const jobs = new BacktestJobs(d.config, d.repos, d.registry);

  /** Returns the actor name or replies 401/403. */
  const operator = (
    req: FastifyRequest,
    reply: FastifyReply,
    opts: { liveCritical?: boolean; allowAnonymous?: boolean } = {},
  ): string | null => {
    const token = d.secrets.operatorToken?.trim();
    const given = String(req.headers['x-operator-token'] ?? '').trim();
    if (!token) {
      if (opts.liveCritical || process.env.NODE_ENV === 'production') {
        reply.code(403).send({ error: 'OPERATOR_TOKEN is not configured on the server; operator actions are disabled' });
        return null;
      }
      return 'local-dev';
    }
    if (!given) {
      if (opts.allowAnonymous && !opts.liveCritical && d.engine.mode !== 'LIVE') {
        return String(req.headers['x-operator-name'] ?? 'dashboard');
      }
      reply.code(401).send({ error: 'invalid or missing X-Operator-Token' });
      return null;
    }
    if (!safeEq(given, token)) {
      reply.code(401).send({ error: 'invalid or missing X-Operator-Token' });
      return null;
    }
    return String(req.headers['x-operator-name'] ?? 'operator');
  };

  app.setErrorHandler((err, _req, reply) => {
    log.error({ err: err.message }, 'api error');
    reply.code(err.statusCode ?? 500).send({ error: err.message });
  });

  // ------------------------------------------------------------------ health / metrics
  app.get('/health', async () => ({ status: 'ok', ts: Date.now() }));
  app.get('/health/ready', async (_req, reply) => {
    const db = await d.repos.ping();
    const ages = d.config.app.symbols.map((s) => d.market.dataAgeMs(s));
    const fresh = ages.every((a) => a <= d.config.risk.staleDataMs * 3);
    const ok = db && fresh;
    reply.code(ok ? 200 : 503).send({ ok, db, marketDataFresh: fresh, dataAgeMs: ages, socket: d.market.socketStatus?.(), lease: d.engine.hasLease });
  });
  app.get('/metrics', async (_req, reply) => {
    reply.header('Content-Type', 'text/plain; version=0.0.4');
    return metrics.render();
  });

  // ------------------------------------------------------------------ status / regimes / indicators
  app.get('/api/status', async () => d.engine.status());

  app.get('/api/regimes', async () => Object.fromEntries(d.config.app.symbols.map((s) => [s, d.engine.regimes.get(s) ?? null])));
  app.get<{ Params: { symbol: string }; Querystring: { limit?: string; before?: string } }>('/api/regimes/:symbol/history', async (req) =>
    d.repos.regimes.history(req.params.symbol, { limit: num(req.query.limit, 300), before: req.query.before ? Number(req.query.before) : undefined }),
  );

  app.get<{ Params: { symbol: string } }>('/api/indicators/:symbol', async (req, reply) => {
    const s = req.params.symbol;
    if (!d.config.app.symbols.includes(s)) return reply.code(404).send({ error: 'unknown symbol' });
    const tfs = d.config.app.timeframes;
    const chain = d.market.chain(s);
    const fv = extractFeatures({
      candles: Object.fromEntries(tfs.map((tf) => [tf, d.market.closedCandles(s, tf)])),
      decisionTf: d.config.app.decisionTimeframe,
      higherTfs: tfs.filter((t) => t !== d.config.app.decisionTimeframe),
      fundingRate: d.market.mark(s)?.fundingRate,
      chainMetrics: chain?.metrics,
      ivHistory: d.market.ivHistory(s),
      openInterestHistory: d.market.oiHistory(s),
    });
    const latest = d.engine.features.get(s) ?? {};
    for (const k of ['alphaDrift', 'alphaRegime', 'alphaMomentum', 'alphaFunding', 'vrpScore', 'volTargetScale', 'forecastVol']) if (latest[k] !== undefined) fv[k] = latest[k];
    const model = await d.registry.active(d.engine.mode);
    const regime = d.engine.regimes.get(s) ?? (model ? classify(s, d.market.now(), fv, model.params.regime, model.version) : null);
    if (model && regime) {
      const fvVol = forecastVolatility(fv, model.params);
      writeAlphaFeatures(fv, alphaDrift(fv, regime, model.params, fvVol), fvVol);
    }
    return {
      symbol: s,
      price: d.market.lastPrice(s),
      topOfBook: d.market.topOfBook(s),
      mark: d.market.mark(s),
      chain: chain ? { source: chain.source, ts: chain.ts, spot: chain.spot, metrics: chain.metrics, expiries: chain.expiries, contracts: chain.contracts.length } : null,
      interpreted: interpretFeatures(fv),
      features: fv,
      regime: d.engine.regimes.get(s) ?? null,
    };
  });

  app.get<{ Params: { symbol: string }; Querystring: { tf?: string; limit?: string } }>('/api/candles/:symbol', async (req, reply) => {
    const tf = (req.query.tf ?? d.config.app.decisionTimeframe) as Timeframe;
    if (!d.config.app.timeframes.includes(tf)) return reply.code(400).send({ error: `timeframe ${tf} not tracked`, supported: d.config.app.timeframes });
    return d.market.closedCandles(req.params.symbol, tf).slice(-num(req.query.limit, 300));
  });

  app.get<{ Params: { symbol: string }; Querystring: { expiry?: string } }>('/api/chain/:symbol', async (req, reply) => {
    const c = d.market.chain(req.params.symbol);
    if (!c) return reply.code(404).send({ error: 'no chain' });
    const exp = req.query.expiry ? Number(req.query.expiry) : c.expiries.find((e) => e - c.ts > 2 * 86_400_000) ?? c.expiries[0];
    return { ...c, contracts: c.contracts.filter((x) => x.expiry === exp), selectedExpiry: exp };
  });

  // ------------------------------------------------------------------ decisions / orders / positions / trades
  app.get<{ Querystring: { symbol?: string; limit?: string; before?: string; action?: string } }>('/api/decisions', async (req) => {
    const f: Record<string, unknown> = {};
    if (req.query.symbol) f.symbol = req.query.symbol;
    if (req.query.action) f.action = req.query.action;
    const rows = await d.repos.decisions.list(f, { limit: Math.min(500, num(req.query.limit, 100)), before: req.query.before ? Number(req.query.before) : undefined });
    return rows.map((r) => ({ ...r, candidates: r.candidates.map((c) => ({ ...c, legs: c.legs.length })) }));
  });
  app.get<{ Params: { id: string } }>('/api/decisions/:id', async (req, reply) => {
    const r = await d.repos.decisions.list({ id: req.params.id }, { limit: 1 });
    if (!r.length) return reply.code(404).send({ error: 'not found' });
    const outcome = await d.repos.outcomes.list({ decisionId: req.params.id }, { limit: 1 });
    return { ...r[0], outcome: outcome[0] ?? null };
  });
  app.get<{ Querystring: { mode?: string; limit?: string } }>('/api/orders', async (req) => d.repos.orders.recent(asMode(req.query.mode), { limit: num(req.query.limit, 100) }));
  app.get<{ Querystring: { mode?: string; status?: string; limit?: string } }>('/api/positions', async (req) => {
    const rows = await d.repos.positions.list(asMode(req.query.mode), { limit: num(req.query.limit, 200) });
    return req.query.status === 'open' ? rows.filter((p) => ['OPENING', 'OPEN', 'CLOSING'].includes(p.status)) : rows;
  });
  app.get<{ Querystring: { mode?: string; limit?: string; strategy?: string; regime?: string } }>('/api/trades', async (req) => {
    const f: Record<string, unknown> = {};
    if (asMode(req.query.mode)) f.mode = req.query.mode;
    if (req.query.strategy) f.strategy = req.query.strategy;
    if (req.query.regime) f.regime = req.query.regime;
    return (await d.repos.trades.list(f, { limit: Math.min(5000, num(req.query.limit, 500)) })).map((t) => ({ ...t, featuresAtEntry: undefined }));
  });

  app.get<{ Querystring: { mode?: string; modelVersion?: string } }>('/api/performance', async (req) => {
    const f: Record<string, unknown> = {};
    const mode = asMode(req.query.mode) ?? 'PAPER';
    f.mode = mode;
    if (req.query.modelVersion) f.modelVersion = req.query.modelVersion;
    const trades = (await d.repos.trades.list(f, { limit: 100_000 })).map((t) => stripLedger(t));
    const eq = await d.repos.equity.series(mode, Date.now() - 365 * 86_400_000);
    const strip = <T extends { rValues: number[] }>(m: T) => ({ ...m, rValues: undefined });
    const by = (fn: (t: (typeof trades)[number]) => string) => Object.fromEntries(Object.entries(breakdown(trades, fn)).map(([k, v]) => [k, strip(v)]));
    return {
      mode,
      overall: strip(tradeMetrics(trades, d.config.paper.startingBalance)),
      curve: curveMetrics(eq.map((e) => ({ ts: e.ts, equity: e.equity }))),
      byRegime: by((t) => t.regime),
      byStrategy: by((t) => t.strategy),
      byRegimeStrategy: by((t) => `${t.regime}|${t.strategy}`),
      byModel: by((t) => t.modelVersion),
      byExitReason: by((t) => t.exitReason),
    };
  });

  app.get<{ Querystring: { mode?: string; days?: string } }>('/api/equity', async (req) =>
    d.repos.equity.series(asMode(req.query.mode) ?? 'PAPER', Date.now() - num(req.query.days, 30) * 86_400_000),
  );

  app.get('/api/risk', async () => {
    const st = (await d.engine.status()) as { accounts: Record<string, Record<string, number>>; mode: Mode };
    const acct = st.accounts[st.mode];
    const L = d.engine.limits;
    const open = (await d.repos.positions.listOpen(st.mode)).filter((p) => positionExchange(p) === d.config.app.exchange);
    const openRisk = open.reduce((s, p) => s + p.maxLoss, 0);
    return {
      mode: st.mode,
      limits: L,
      killSwitch: d.engine.killSwitch.get(),
      utilisation: {
        dailyLossPct: { value: acct.dailyLossPct, limit: L.dailyLossLimitPct },
        drawdownPct: { value: acct.drawdownPct, limit: L.maxDrawdownPct },
        openPositions: { value: open.length, limit: L.maxOpenPositions },
        premiumAtRiskPct: { value: acct.equity > 0 ? (openRisk / acct.equity) * 100 : 0, limit: L.maxTotalPremiumAtRiskPct },
        consecutiveLosses: { value: acct.consecutiveLosses, limit: L.maxConsecutiveLosses },
      },
      openPositions: open.map((p) => ({ id: p.id, strategy: p.strategy, underlying: p.underlying, maxLoss: p.maxLoss, lastMarkPnl: p.lastMarkPnl, exitPlan: p.exitPlan })),
    };
  });

  app.get('/api/strategies', async () => {
    const m = await d.registry.active('PAPER');
    return {
      modelVersion: m?.version,
      strategies: STRATEGIES.map((s) => ({ name: s, ...STRATEGY_INFO[s], params: m?.params.strategies[s] })),
      affinity: m?.params.affinity,
      regimes: REGIMES,
      selection: m?.params.selection,
      exits: m?.params.exits,
      forecast: m?.params.forecast,
    };
  });

  // ------------------------------------------------------------------ models / learning
  app.get('/api/models', async () => (await d.repos.models.list()).map((m) => ({ ...m, validation: m.validation ? { ...m.validation, oosRValues: undefined } : undefined })));
  app.get<{ Params: { version: string } }>('/api/models/:version', async (req, reply) => (await d.repos.models.get(req.params.version)) ?? reply.code(404).send({ error: 'not found' }));
  app.get<{ Querystring: { limit?: string } }>('/api/experiments', async (req) => d.repos.experiments.list({}, { limit: num(req.query.limit, 100) }));
  app.get('/api/learning/status', async () => d.learning.status);
  app.post('/api/learning/run', async (req, reply) => {
    const actor = operator(req, reply, { allowAnonymous: d.engine.mode !== 'LIVE' });
    if (!actor) return;
    if (d.learning.status.running) return reply.code(409).send({ error: 'already running' });
    void d.learning.runWalkForward(`manual by ${actor}`).catch((e) => log.error({ err: (e as Error).message }, 'manual walk-forward failed'));
    return { started: true };
  });
  app.post<{ Params: { version: string }; Body: { confirm?: string } }>('/api/models/:version/approve-live', async (req, reply) => {
    const actor = operator(req, reply, { liveCritical: true });
    if (!actor) return;
    if (req.body?.confirm !== `APPROVE ${req.params.version}`) return reply.code(400).send({ error: `body.confirm must equal "APPROVE ${req.params.version}"` });
    return d.learning.approveLive(req.params.version, actor);
  });
  app.post<{ Params: { version: string } }>('/api/models/:version/activate-paper', async (req, reply) => {
    const actor = operator(req, reply, { allowAnonymous: d.engine.mode !== 'LIVE' });
    if (!actor) return;
    await d.registry.activatePaper(req.params.version, actor);
    await d.repos.audit.append({ id: uuid(), ts: Date.now(), actor, action: 'MODEL_ACTIVATED_PAPER', details: { version: req.params.version } });
    return { ok: true };
  });
  app.post<{ Body: { mode?: string; reason?: string } }>('/api/models/rollback', async (req, reply) => {
    const mode = asMode(req.body?.mode) ?? 'PAPER';
    const actor = operator(req, reply, { liveCritical: mode === 'LIVE', allowAnonymous: mode !== 'LIVE' });
    if (!actor) return;
    const to = await d.registry.rollback(mode, req.body?.reason ?? 'manual rollback', {}, actor);
    return { ok: !!to, rolledBackTo: to };
  });

  // ------------------------------------------------------------------ backtests
  app.post<{ Body: { from?: number; to?: number; symbols?: string[]; policy?: string; strategy?: StrategyName; modelVersion?: string; decisionEveryBars?: number; compareBaselines?: boolean } }>(
    '/api/backtests',
    async (req, reply) => {
      const actor = operator(req, reply, { allowAnonymous: d.engine.mode !== 'LIVE' });
      if (!actor) return;
      return jobs.start(req.body ?? {});
    },
  );
  app.get('/api/backtests', async () => jobs.list());
  app.get<{ Params: { id: string } }>('/api/backtests/:id', async (req, reply) => jobs.get(req.params.id) ?? reply.code(404).send({ error: 'not found' }));

  // ------------------------------------------------------------------ alerts / audit
  app.get<{ Querystring: { limit?: string } }>('/api/alerts', async (req) => d.repos.alerts.recent({ limit: num(req.query.limit, 100) }));
  app.post<{ Params: { id: string } }>('/api/alerts/:id/ack', async (req, reply) => {
    const actor = operator(req, reply, { allowAnonymous: d.engine.mode !== 'LIVE' });
    if (!actor) return;
    await d.repos.alerts.acknowledge(req.params.id);
    return { ok: true };
  });
  app.get<{ Querystring: { limit?: string } }>('/api/audit', async (req) => d.repos.audit.list({}, { limit: num(req.query.limit, 200) }));
  app.get('/api/audit/verify', async () => {
    const out: Record<string, unknown> = {};
    for (const k of ['decisions', 'outcomes', 'orderEvents', 'fills', 'trades', 'experiments', 'audit'] as const) out[k] = await d.repos[k].verifyChain();
    return out;
  });

  // ------------------------------------------------------------------ operator controls
  app.post<{ Body: { action: 'engage' | 'release'; reason?: string; flatten?: boolean } }>('/api/kill-switch', async (req, reply) => {
    const b = req.body ?? ({} as { action: 'engage' });
    if (b.action === 'engage') {
      const actor = String(req.headers['x-operator-name'] ?? 'dashboard');
      await d.engine.killSwitch.engage('MANUAL', b.reason ?? 'manual', actor, !!b.flatten);
      return { ok: true, killSwitch: d.engine.killSwitch.get() };
    }
    const actor = operator(req, reply, { liveCritical: d.engine.mode === 'LIVE', allowAnonymous: d.engine.mode !== 'LIVE' });
    if (!actor) return;
    await d.engine.killSwitch.release(actor, b.reason ?? 'manual release');
    return { ok: true, killSwitch: d.engine.killSwitch.get() };
  });

  app.get('/api/live/readiness', async () => d.engine.liveReadiness());
  app.post<{ Body: { confirmPhrase?: string } }>('/api/live/arm', async (req, reply) => {
    const actor = operator(req, reply, { liveCritical: true });
    if (!actor) return;
    const r = await d.engine.armLive(actor, req.body?.confirmPhrase ?? '');
    if (!r.ok) reply.code(400);
    return { ...r, requiredPhrase: LIVE_CONFIRM_PHRASE };
  });
  app.post<{ Body: { reason?: string } }>('/api/live/disarm', async (req, reply) => {
    // disarming is the safe direction: allowed with or without token, but still audited
    const actor = d.secrets.operatorToken && req.headers['x-operator-token'] ? operator(req, reply) : 'dashboard';
    if (!actor) return;
    await d.engine.disarmLive(actor, req.body?.reason ?? 'manual');
    return { ok: true };
  });
  app.post<{ Body: { decisionId?: string } }>('/api/live/confirm-first-order', async (req, reply) => {
    const actor = operator(req, reply, { liveCritical: true });
    if (!actor) return;
    const r = await d.engine.confirmFirstLiveOrder(actor, String(req.body?.decisionId ?? ''));
    if (!r.ok) reply.code(400);
    return r;
  });
  app.post<{ Params: { id: string } }>('/api/positions/:id/close', async (req, reply) => {
    const p = await d.repos.positions.get(req.params.id);
    if (!p) return reply.code(404).send({ error: 'not found' });
    const actor = operator(req, reply, { liveCritical: p.mode === 'LIVE', allowAnonymous: p.mode !== 'LIVE' });
    if (!actor) return;
    return d.engine.closePositionManually(req.params.id, actor);
  });
  app.post<{ Body: { balance?: number } }>('/api/paper/reset', async (req, reply) => {
    const actor = operator(req, reply, { allowAnonymous: d.engine.mode !== 'LIVE' });
    if (!actor) return;
    const open = await d.repos.positions.listOpen('PAPER');
    if (open.length) return reply.code(409).send({ error: `close ${open.length} open paper position(s) first` });
    const bal = num(req.body?.balance, d.config.paper.startingBalance);
    await d.engine.accounts.PAPER.reset(bal);
    await d.repos.audit.append({ id: uuid(), ts: Date.now(), actor, action: 'PAPER_RESET', details: { balance: bal } });
    return { ok: true, balance: bal };
  });
  app.post<{ Params: { symbol: string } }>('/api/decide/:symbol', async (req, reply) => {
    const actor = operator(req, reply, { liveCritical: d.engine.mode === 'LIVE', allowAnonymous: d.engine.mode !== 'LIVE' });
    if (!actor) return;
    return d.engine.decideSymbol(req.params.symbol);
  });

  registerExchangeRoutes(app, { config: d.config, exchange: d.exchange, exchangeInfo: d.exchangeInfo, market: d.market });

  // ------------------------------------------------------------------ SSE stream
  app.get('/api/stream', async (req, reply) => {
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    const send = (event: string, data: unknown) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const onDecision = (r: unknown) => send('decision', r);
    const onPosition = (p: unknown) => send('position', p);
    const onAlert = (a: unknown) => send('alert', a);
    d.engine.on('decision', onDecision);
    d.engine.on('position', onPosition);
    d.alerts.on('alert', onAlert);
    const tick = setInterval(async () => send('status', await d.engine.status().catch(() => null)), 5000);
    send('status', await d.engine.status());
    req.raw.on('close', () => {
      clearInterval(tick);
      d.engine.off('decision', onDecision);
      d.engine.off('position', onPosition);
      d.alerts.off('alert', onAlert);
    });
    return reply;
  });

  return app;
}
