import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { config as loadDotenv } from 'dotenv';
import { parseProperties, findSecretKeys } from './properties.js';

/** Load .env from cwd, then repo root (apps/backend → ../../.env), without overriding already-set env vars. */
(() => {
  const seen = new Set<string>();
  for (const p of [process.env.DOTENV_CONFIG_PATH, resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env'), resolve(process.cwd(), '../.env')]) {
    if (!p) continue;
    const abs = resolve(p);
    if (seen.has(abs) || !existsSync(abs)) continue;
    seen.add(abs);
    loadDotenv({ path: abs, override: false });
  }
})();

import { ConfigError } from '../lib/errors.js';
import { registerSecret } from '../lib/logger.js';
import type { Timeframe } from '../domain/types.js';

/**
 * Configuration precedence (highest first):
 *   1. Environment variables (APP_HTTP_PORT overrides app.http.port, i.e. upper-case, '.'/'-' -> '_')
 *   2. config/application-{profile}.properties (APP_PROFILE)
 *   3. config/application.properties
 *   4. Defaults below
 * Secrets (API key/secret, operator token, DB password) are ONLY read from env / secret manager.
 */

const num = (d: number) => z.coerce.number().default(d);
const bool = (d: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .default(d)
    .transform((v) => (typeof v === 'boolean' ? v : ['true', '1', 'yes', 'on'].includes(v.toLowerCase())));
const list = (d: string[]) =>
  z
    .union([z.array(z.string()), z.string()])
    .default(d)
    .transform((v) => (Array.isArray(v) ? v : v.split(',').map((s) => s.trim()).filter(Boolean)));

const TF = z.enum(['1m', '5m', '15m', '1h', '4h', '1d']);

export const ConfigSchema = z.object({
  app: z.object({
    profile: z.string().default('default'),
    /** Startup mode. LIVE additionally needs the operator to ARM it at runtime. */
    mode: z.enum(['PAPER', 'LIVE']).default('PAPER'),
    /**
     * Which futures exchange to connect: 'coindcx' or 'delta'. `npm run dev` asks at startup;
     * env EXCHANGE=delta (or APP_EXCHANGE) overrides. app.symbols/app.underlying-map are used for
     * CoinDCX; delta.symbols/delta.underlying-map for Delta.
     */
    exchange: z.enum(['coindcx', 'delta']).default('coindcx'),
    http: z.object({ port: num(8080), host: z.string().default('0.0.0.0'), corsOrigins: list(['http://localhost:3000']) }),
    symbols: list(['B-BTC_USDT', 'B-ETH_USDT']),
    /** Map futures pair -> options underlying code (for reference chain / option symbols). */
    underlyingMap: z.string().default('B-BTC_USDT:BTC,B-ETH_USDT:ETH'),
    timeframes: z
      .union([z.array(TF), z.string()])
      .default(['15m', '1h', '4h', '1d'])
      .transform((v) => (Array.isArray(v) ? v : (v.split(',').map((s) => s.trim()) as Timeframe[]))),
    decisionTimeframe: TF.default('15m'),
    decisionIntervalSec: num(60),
    positionMonitorIntervalSec: num(5),
    historyBars: num(500),
  }),
  coindcx: z.object({
    apiBaseUrl: z.string().default('https://api.coindcx.com'),
    publicBaseUrl: z.string().default('https://public.coindcx.com'),
    socketUrl: z.string().default('wss://stream.coindcx.com'),
    /** CoinDCX futures candlestick `resolution` values per timeframe (overridable). */
    resolutionMap: z.string().default('1m:1,5m:5,15m:15,1h:60,4h:240,1d:1D'),
    httpTimeoutMs: num(10_000),
    maxRequestsPerMinute: num(600),
    marginCurrency: z.string().default('USDT'),
    futuresWalletPath: z.string().default('/exchange/v1/derivatives/futures/wallets'),
    futuresWalletMethod: z.enum(['GET', 'POST']).default('GET'),
    currentPricesPath: z.string().default('/market_data/v3/current_prices/futures/rt'),
    /** send client_order_id on futures create (enable only after confirming your API version accepts it) */
    sendClientOrderId: bool(false),
    /** Options trading via API is NOT documented by CoinDCX (verified 2026-10). Keep false until verified. */
    optionsApiEnabled: bool(false),
    optionsCreateOrderPath: z.string().default(''),
    optionsCancelOrderPath: z.string().default(''),
    optionsPositionsPath: z.string().default(''),
    optionsChainPath: z.string().default(''),
  }),
  delta: z.object({
    /** india (default) | india-testnet | global | a full base URL. Keys are per environment. */
    environment: z.string().default('india'),
    /** perpetual symbols on Delta (contracts: BTCUSD = 0.001 BTC, ETHUSD = 0.01 ETH) */
    symbols: list(['BTCUSD', 'ETHUSD']),
    underlyingMap: z.string().default('BTCUSD:BTC,ETHUSD:ETH'),
    marginCurrency: z.string().default('USD'),
    httpTimeoutMs: num(10_000),
    /** Delta quota is 20,000 weight / 5 min (orders weigh 5, reads 3): 600 req/min stays well inside it. */
    maxRequestsPerMinute: num(600),
  }),
  reference: z.object({
    /**
     * REAL options data from Deribit's public API (CoinDCX has no options API). Used for IV/skew/PCR
     * features and PAPER option fills at the real bid/ask. Disabled => no option strategies at all.
     */
    deribitEnabled: bool(true),
    deribitBaseUrl: z.string().default('https://www.deribit.com/api/v2'),
    refreshSec: num(60),
  }),
  db: z.object({
    /** 'mongo' for production; 'memory' only for tests / throwaway dry runs. */
    driver: z.enum(['mongo', 'memory']).default('mongo'),
    name: z.string().default('crypto_hacks'),
    maxPoolSize: num(20),
    /** Use multi-document transactions (requires a replica set; recommended in production). */
    transactions: bool(true),
    writeConcern: z.string().default('majority'),
  }),
  risk: z.object({
    capital: num(10_000),
    maxRiskPerTradePct: num(1.0),
    dailyLossLimitPct: num(3.0),
    maxDrawdownPct: num(15.0),
    maxOpenPositions: num(3),
    maxPositionsPerUnderlying: num(1),
    maxTotalPremiumAtRiskPct: num(5.0),
    maxNotionalExposurePct: num(100.0),
    maxNetDeltaPctOfCapital: num(50.0),
    maxLeverage: num(3),
    maxSpreadPct: num(8.0),
    minOpenInterest: num(0),
    minLiquidityScore: num(0.2),
    staleDataMs: num(20_000),
    minConfidence: num(0.55),
    minExpectedValuePerRisk: num(0.02),
    minProbabilityOfProfit: num(0.25),
    maxConsecutiveLosses: num(5),
    cooldownAfterLossMin: num(30),
    maxOrdersPerMinute: num(20),
    minDaysToExpiry: num(2),
    maxDaysToExpiry: num(45),
    // per-strategy edge monitor (learning/edge-monitor.ts): pause new entries of a losing strategy
    edgeMonitorEnabled: bool(true),
    edgeMonitorWindow: num(30),
    edgeMonitorMinTrades: num(15),
    edgeMonitorTStat: num(-1.5),
    edgeMonitorMaxCumLossR: num(6),
    edgeMonitorPauseHours: num(72),
  }),
  exits: z.object({
    stopLossPct: num(50),
    takeProfitPct: num(100),
    trailingActivationPct: num(40),
    trailingDistancePct: num(25),
    maxHoldHours: num(72),
    expiryBufferHours: num(12),
    regimeInvalidationConfidence: num(0.7),
    // ---- Profit Guard (auto profit exit). Percentages are of the position's max loss (1R = 100%).
    profitGuardEnabled: bool(true),
    /** once peak P&L reaches this, the stop moves to break-even + buffer (a winner never becomes a loser) */
    breakevenAtPct: num(50),
    breakevenBufferPct: num(5),
    /** ratchet "peak:lockFraction" pairs: after peak >= X% of risk, keep at least fraction*peak */
    profitLockSteps: z.string().default('100:0.4,200:0.55,300:0.65,500:0.75'),
    /** options with a known max profit: bank it when this share is captured (credit / debit structures) */
    creditCapturePct: num(50),
    debitCapturePct: num(75),
    // ---- Exit Engine v2 (risk/exit-engine.ts) for futures sleeves: R-based stop, milestones, trailing.
    /** 'v2' = new engine (PAPER/backtest), 'legacy' = %-of-risk rules only */
    engine: z.enum(['legacy', 'v2']).default('v2'),
    /** v2 manages LIVE positions only when explicitly approved */
    engineV2Live: bool(false),
    /** "R:fractionOfOriginalQty:lockStopAtR" - e.g. at +1R book 50% and move stop to break-even after costs */
    v2Milestones: z.string().default('1:0.5:0,2:0.25:1'),
    /** trend sleeves: do not cut winners early - move to break-even at +1R, book a little at +3R */
    v2TrendMilestones: z.string().default('1:0:0,3:0.25:1.5'),
    chandelierAtrMult: num(3),
    trailActivateR: num(1),
    /** non-trend sleeves close the rest at +N R (0 = off) */
    finalTargetR: num(3),
  }),
  paper: z.object({
    startingBalance: num(10_000),
    latencyMs: num(250),
    latencyJitterMs: num(150),
    slippageBps: num(5),
    impactBpsPerDepthPct: num(10),
    takerFeeBps: num(5),
    makerFeeBps: num(2),
    /** Option fee model (Deribit-like): pctOfUnderlying * S per contract, capped at capPctOfPremium * premium. */
    optionFeePctOfUnderlying: num(0.03),
    optionFeeCapPctOfPremium: num(12.5),
    /** Stress-test knobs (random partial fills / rejects). 0 = fills follow the real order book only. */
    partialFillProbability: num(0),
    rejectProbability: num(0),
    fundingIntervalHours: num(8),
    seed: num(42),
  }),
  learning: z.object({
    enabled: bool(true),
    evaluationIntervalMin: num(60),
    minTradesForEvaluation: num(30),
    minOosTrades: num(20),
    walkForwardTrainDays: num(60),
    walkForwardTestDays: num(15),
    walkForwardFolds: num(4),
    significanceAlpha: num(0.05),
    maxParamChangePct: num(20),
    rollbackDrawdownMultiple: num(1.5),
    rollbackMinTrades: num(15),
    candidatesPerCycle: num(12),
    autoPromoteToPaper: bool(true),
  }),
  alerts: z.object({
    minLevel: z.enum(['info', 'warn', 'error', 'critical']).default('warn'),
  }),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export interface Secrets {
  coindcxApiKey?: string;
  coindcxApiSecret?: string;
  deltaApiKey?: string;
  deltaApiSecret?: string;
  operatorToken?: string;
  mongoUri: string;
  alertWebhookUrl?: string;
}

function kebabToCamel(s: string) {
  return s.replace(/[-_]([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Turn flat `a.b-c=x` keys into nested `{a:{bC:'x'}}`. */
export function nest(flat: Record<string, string>): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flat)) {
    const parts = k.split('.').map(kebabToCamel);
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
      cur = cur[p] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]] = v;
  }
  return root;
}

/** Collect env overrides for every known schema leaf, e.g. RISK_MAX_RISK_PER_TRADE_PCT. */
function envOverrides(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  const shape = ConfigSchema.shape as Record<string, z.ZodObject<z.ZodRawShape>>;
  for (const [section, obj] of Object.entries(shape)) {
    const inner = (obj as z.ZodObject<z.ZodRawShape>).shape;
    for (const key of Object.keys(inner)) {
      const val = inner[key];
      if (val instanceof z.ZodObject) {
        for (const sub of Object.keys(val.shape)) {
          const envName = `${section}_${key}_${sub}`.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
          if (env[envName] !== undefined) out[`${section}.${key}.${sub}`] = env[envName]!;
        }
      } else {
        const envName = `${section}_${key}`.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
        if (env[envName] !== undefined) out[`${section}.${key}`] = env[envName]!;
      }
    }
  }
  return out;
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k] !== null) {
      out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else out[k] = v;
  }
  return out;
}

export interface LoadOptions {
  configDir?: string;
  env?: NodeJS.ProcessEnv;
  overrides?: Record<string, unknown>;
}

export function loadConfig(opts: LoadOptions = {}): { config: AppConfig; secrets: Secrets; sources: string[] } {
  const env = opts.env ?? process.env;
  const dir = opts.configDir ?? env.CONFIG_DIR ?? resolve(process.cwd(), '../../config');
  const altDir = resolve(process.cwd(), 'config');
  const configDir = existsSync(dir) ? dir : altDir;
  const profile = env.APP_PROFILE ?? 'default';
  const files = [resolve(configDir, 'application.properties')];
  if (profile !== 'default') files.push(resolve(configDir, `application-${profile}.properties`));

  let merged: Record<string, unknown> = {};
  const sources: string[] = [];
  for (const f of files) {
    if (!existsSync(f)) continue;
    const text = readFileSync(f, 'utf8');
    const literal = parseProperties(text, {});
    const bad = findSecretKeys(literal);
    if (bad.length) {
      throw new ConfigError(
        `Secrets must not be stored in ${f}. Move these keys to environment variables / secret manager: ${bad.join(', ')}`,
      );
    }
    const resolved = parseProperties(text, env);
    merged = deepMerge(merged, nest(resolved));
    sources.push(f);
  }
  merged = deepMerge(merged, nest(envOverrides(env)));
  if (env.EXCHANGE) merged = deepMerge(merged, { app: { exchange: env.EXCHANGE.trim().toLowerCase() } });
  if (opts.overrides) merged = deepMerge(merged, opts.overrides);
  for (const s of ['app', 'coindcx', 'delta', 'reference', 'db', 'risk', 'exits', 'paper', 'learning', 'alerts']) {
    if (!merged[s]) merged[s] = {};
  }
  const app = merged.app as Record<string, unknown>;
  if (!app.http) app.http = {};
  app.profile = profile;

  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) throw new ConfigError('Invalid configuration', parsed.error.flatten());
  // the active exchange decides which instruments the whole engine trades
  if (parsed.data.app.exchange === 'delta') {
    parsed.data.app.symbols = parsed.data.delta.symbols;
    parsed.data.app.underlyingMap = parsed.data.delta.underlyingMap;
  }
  validateSemantics(parsed.data);

  const secrets: Secrets = {
    coindcxApiKey: env.COINDCX_API_KEY || undefined,
    coindcxApiSecret: env.COINDCX_API_SECRET || undefined,
    deltaApiKey: env.DELTA_API_KEY || undefined,
    deltaApiSecret: env.DELTA_API_SECRET || undefined,
    operatorToken: env.OPERATOR_TOKEN || undefined,
    mongoUri: env.MONGODB_URI ?? 'mongodb://localhost:27017/?replicaSet=rs0',
    alertWebhookUrl: env.ALERT_WEBHOOK_URL || undefined,
  };
  registerSecret(secrets.coindcxApiKey);
  registerSecret(secrets.coindcxApiSecret);
  registerSecret(secrets.deltaApiKey);
  registerSecret(secrets.deltaApiSecret);
  registerSecret(secrets.operatorToken);
  const pw = /:\/\/[^:/]+:([^@]+)@/.exec(secrets.mongoUri)?.[1];
  registerSecret(pw);
  return { config: Object.freeze(parsed.data) as AppConfig, secrets, sources };
}

function validateSemantics(c: AppConfig) {
  const r = c.risk;
  const errs: string[] = [];
  if (r.maxRiskPerTradePct <= 0 || r.maxRiskPerTradePct > 10) errs.push('risk.max-risk-per-trade-pct must be in (0,10]');
  if (r.dailyLossLimitPct <= 0 || r.dailyLossLimitPct > 50) errs.push('risk.daily-loss-limit-pct must be in (0,50]');
  if (r.maxDrawdownPct <= 0 || r.maxDrawdownPct > 90) errs.push('risk.max-drawdown-pct must be in (0,90]');
  if (r.maxRiskPerTradePct > r.dailyLossLimitPct) errs.push('risk.max-risk-per-trade-pct must be <= daily-loss-limit-pct');
  if (r.maxOpenPositions < 1) errs.push('risk.max-open-positions must be >= 1');
  if (r.maxLeverage < 1 || r.maxLeverage > 25) errs.push('risk.max-leverage must be in [1,25]');
  if (c.exits.stopLossPct <= 0 || c.exits.stopLossPct > 100) errs.push('exits.stop-loss-pct must be in (0,100]');
  if (!c.app.timeframes.includes(c.app.decisionTimeframe)) errs.push('app.decision-timeframe must be one of app.timeframes');
  if (errs.length) throw new ConfigError(`Configuration rejected: ${errs.join('; ')}`);
}

export function parseMap(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of s.split(',')) {
    const [k, v] = pair.split(':').map((x) => x.trim());
    if (k && v) out[k] = v;
  }
  return out;
}

/** Deep-frozen hard risk limits. The learning engine receives NO reference to a mutable copy. */
export type HardRiskLimits = Readonly<AppConfig['risk']> & { readonly exits: Readonly<AppConfig['exits']> };
export function hardRiskLimits(c: AppConfig): HardRiskLimits {
  return Object.freeze({ ...c.risk, exits: Object.freeze({ ...c.exits }) });
}
