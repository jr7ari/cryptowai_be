/**
 * Model registry: versioned parameter sets with a strict lifecycle.
 *
 *   CANDIDATE --(walk-forward OOS passes promotion criteria)--> VALIDATED --(auto)--> ACTIVE_PAPER
 *   ACTIVE_PAPER/VALIDATED --(explicit operator approval + live criteria)--> APPROVED_LIVE
 *   any active --(underperforms validated baseline)--> ROLLED_BACK (parent re-activated)
 *
 * Learned models are NEVER auto-deployed to LIVE. Every transition is written to the immutable
 * experiments ledger and operator actions to the audit ledger.
 */
import type { Repositories, ModelVersionDoc, ModelStatus } from '../persistence/ports.js';
import type { Mode } from '../domain/types.js';
import { defaultModelParams, enforceBounds, modelHash, withDefaults, type ModelParams } from './params.js';
import { uuid } from '../lib/ids.js';
import type { Clock } from '../lib/clock.js';
import { childLogger } from '../lib/logger.js';

const log = childLogger('model-registry');

export interface ActiveModel {
  version: string;
  params: ModelParams;
}

export class ModelRegistry {
  private cache = new Map<Mode, ActiveModel>();
  constructor(private readonly repos: Repositories, private readonly clock: Clock) {}

  async ensureBaseline(): Promise<ModelVersionDoc> {
    const all = await this.repos.models.list();
    if (all.length) return all[all.length - 1];
    const params = defaultModelParams();
    enforceBounds(params);
    const doc: ModelVersionDoc = {
      version: `m1-${modelHash(params)}`,
      parentVersion: null,
      createdAt: this.clock.now(),
      status: 'ACTIVE_PAPER',
      params,
      validation: { note: 'hand-specified baseline prior; not learned' },
      activeInPaper: true,
      activeInLive: false,
      notes: 'Baseline model (default priors). Must be explicitly approved before LIVE use.',
    };
    await this.repos.models.insert(doc);
    await this.repos.experiments.append({
      id: uuid(),
      ts: this.clock.now(),
      kind: 'PROMOTION',
      modelVersion: doc.version,
      summary: 'Baseline model created and activated for PAPER',
      metrics: {},
      decision: 'ACTIVE_PAPER',
    });
    log.info({ version: doc.version }, 'baseline model created');
    return doc;
  }

  async active(mode: Mode): Promise<ActiveModel | null> {
    const c = this.cache.get(mode);
    if (c) return c;
    const doc = await this.repos.models.activeFor(mode);
    if (!doc) return null;
    const am = { version: doc.version, params: withDefaults(doc.params) };
    this.cache.set(mode, am);
    return am;
  }

  invalidate() {
    this.cache.clear();
  }

  async createCandidate(params: ModelParams, parentVersion: string, notes: string, validation?: Record<string, unknown>): Promise<ModelVersionDoc> {
    const p = structuredClone(params);
    const clamped = enforceBounds(p);
    const all = await this.repos.models.list();
    const doc: ModelVersionDoc = {
      version: `m${all.length + 1}-${modelHash(p)}`,
      parentVersion,
      createdAt: this.clock.now(),
      status: 'CANDIDATE',
      params: p,
      validation: { ...validation, clamped },
      activeInPaper: false,
      activeInLive: false,
      notes,
    };
    if (await this.repos.models.get(doc.version)) return (await this.repos.models.get(doc.version))!;
    await this.repos.models.insert(doc);
    return doc;
  }

  private async setStatus(version: string, status: ModelStatus, extra: Partial<ModelVersionDoc> = {}) {
    await this.repos.models.update(version, { status, ...extra });
    this.invalidate();
  }

  async markValidated(version: string, validation: Record<string, unknown>) {
    await this.setStatus(version, 'VALIDATED', { validation });
    await this.repos.experiments.append({ id: uuid(), ts: this.clock.now(), kind: 'PROMOTION', modelVersion: version, summary: 'passed promotion criteria', metrics: validation, decision: 'VALIDATED' });
  }

  async reject(version: string, reason: string, metrics: Record<string, unknown>) {
    await this.setStatus(version, 'REJECTED', { notes: reason });
    await this.repos.experiments.append({ id: uuid(), ts: this.clock.now(), kind: 'REJECTION', modelVersion: version, summary: reason, metrics, decision: 'REJECTED' });
  }

  /** Activate a VALIDATED model for PAPER (deactivates the previous paper model). */
  async activatePaper(version: string, actor = 'learning-engine') {
    const doc = await this.repos.models.get(version);
    if (!doc) throw new Error(`model ${version} not found`);
    if (!['VALIDATED', 'APPROVED_LIVE', 'ACTIVE_PAPER'].includes(doc.status)) throw new Error(`model ${version} is ${doc.status}; must be VALIDATED`);
    const prev = await this.repos.models.activeFor('PAPER');
    if (prev && prev.version !== version) await this.repos.models.update(prev.version, { activeInPaper: false, status: prev.activeInLive ? prev.status : 'RETIRED' });
    await this.repos.models.update(version, { activeInPaper: true, status: doc.status === 'APPROVED_LIVE' ? 'APPROVED_LIVE' : 'ACTIVE_PAPER' });
    this.invalidate();
    await this.repos.experiments.append({ id: uuid(), ts: this.clock.now(), kind: 'PROMOTION', modelVersion: version, baselineVersion: prev?.version, summary: `activated for PAPER by ${actor}`, metrics: {}, decision: 'ACTIVE_PAPER' });
  }

  /**
   * Explicit operator approval for LIVE. Requires VALIDATED/ACTIVE_PAPER status AND recorded
   * out-of-sample evidence meeting live criteria (checked by the caller: learning/promotion.ts).
   */
  async approveLive(version: string, actor: string, evidence: Record<string, unknown>) {
    const doc = await this.repos.models.get(version);
    if (!doc) throw new Error(`model ${version} not found`);
    if (!['VALIDATED', 'ACTIVE_PAPER', 'APPROVED_LIVE'].includes(doc.status)) throw new Error(`model ${version} is ${doc.status}; cannot approve for LIVE`);
    const prev = await this.repos.models.activeFor('LIVE');
    if (prev && prev.version !== version) await this.repos.models.update(prev.version, { activeInLive: false });
    await this.repos.models.update(version, { activeInLive: true, status: 'APPROVED_LIVE', approvedBy: actor, approvedAt: this.clock.now() });
    this.invalidate();
    await this.repos.experiments.append({ id: uuid(), ts: this.clock.now(), kind: 'APPROVAL', modelVersion: version, baselineVersion: prev?.version, summary: `approved for LIVE by ${actor}`, metrics: evidence, decision: 'APPROVED_LIVE' });
    await this.repos.audit.append({ id: uuid(), ts: this.clock.now(), actor, action: 'MODEL_APPROVED_LIVE', details: { version, evidence } });
  }

  /** Roll back the active model of `mode` to its parent (or the last good model). */
  async rollback(mode: Mode, reason: string, metrics: Record<string, unknown>, actor = 'learning-engine'): Promise<string | null> {
    const cur = await this.repos.models.activeFor(mode);
    if (!cur) return null;
    const all = await this.repos.models.list();
    const target =
      (cur.parentVersion ? all.find((m) => m.version === cur.parentVersion && m.status !== 'REJECTED' && m.status !== 'ROLLED_BACK') : undefined) ??
      all.find((m) => m.version !== cur.version && ['VALIDATED', 'ACTIVE_PAPER', 'APPROVED_LIVE', 'RETIRED'].includes(m.status) && (mode === 'PAPER' || m.approvedBy));
    if (!target) {
      log.error({ mode, cur: cur.version }, 'no rollback target available');
      return null;
    }
    await this.repos.models.update(cur.version, mode === 'LIVE' ? { activeInLive: false, status: 'ROLLED_BACK' } : { activeInPaper: false, status: 'ROLLED_BACK' });
    await this.repos.models.update(target.version, mode === 'LIVE' ? { activeInLive: true } : { activeInPaper: true, status: target.status === 'RETIRED' ? 'ACTIVE_PAPER' : target.status });
    this.invalidate();
    await this.repos.experiments.append({ id: uuid(), ts: this.clock.now(), kind: 'ROLLBACK', modelVersion: cur.version, baselineVersion: target.version, summary: `${mode} rollback: ${reason}`, metrics, decision: `ROLLED_BACK -> ${target.version}` });
    await this.repos.audit.append({ id: uuid(), ts: this.clock.now(), actor, action: 'MODEL_ROLLBACK', details: { mode, from: cur.version, to: target.version, reason } });
    log.warn({ mode, from: cur.version, to: target.version, reason }, 'model rolled back');
    return target.version;
  }
}
