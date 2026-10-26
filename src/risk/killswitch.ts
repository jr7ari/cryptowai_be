import type { Repositories } from '../persistence/ports.js';
import { uuid } from '../lib/ids.js';
import { childLogger } from '../lib/logger.js';
import type { Clock } from '../lib/clock.js';

const log = childLogger('killswitch');

export type KillKind = 'MANUAL' | 'DAILY_LOSS' | 'MAX_DRAWDOWN' | 'RECONCILIATION' | 'EXCHANGE_OUTAGE' | 'STALE_DATA' | 'INTERNAL_ERROR';

export interface KillSwitchState {
  engaged: boolean;
  kind?: KillKind;
  reason?: string;
  engagedAt?: number;
  engagedBy?: string;
  /** DAILY_LOSS halts auto-release at the next UTC day; everything else needs an operator. */
  autoReleaseAt?: number;
  /** Flatten all open positions when engaged. */
  flatten: boolean;
}

const KEY = 'killSwitch';

export class KillSwitch {
  private state: KillSwitchState = { engaged: false, flatten: false };
  private listeners: Array<(s: KillSwitchState) => void> = [];
  constructor(private readonly repos: Repositories, private readonly clock: Clock) {}

  async load(): Promise<KillSwitchState> {
    this.state = (await this.repos.state.get<KillSwitchState>(KEY)) ?? { engaged: false, flatten: false };
    return this.state;
  }
  get(): KillSwitchState {
    return { ...this.state };
  }
  onChange(fn: (s: KillSwitchState) => void) {
    this.listeners.push(fn);
  }

  async engage(kind: KillKind, reason: string, actor: string, flatten: boolean): Promise<void> {
    if (this.state.engaged && this.state.kind === kind) return;
    const now = this.clock.now();
    const nextUtcDay = Math.floor(now / 86_400_000 + 1) * 86_400_000;
    // escalate: a more severe kill overrides a daily halt
    this.state = {
      engaged: true,
      kind,
      reason,
      engagedAt: now,
      engagedBy: actor,
      autoReleaseAt: kind === 'DAILY_LOSS' ? nextUtcDay : undefined,
      flatten: flatten || this.state.flatten,
    };
    await this.repos.state.set(KEY, this.state);
    await this.repos.audit.append({ id: uuid(), ts: now, actor, action: 'KILL_SWITCH_ENGAGED', details: { kind, reason, flatten } });
    log.error({ kind, reason, actor, flatten }, 'KILL SWITCH ENGAGED');
    this.listeners.forEach((l) => l(this.get()));
  }

  async release(actor: string, note: string): Promise<void> {
    if (!this.state.engaged) return;
    const prev = this.state;
    this.state = { engaged: false, flatten: false };
    await this.repos.state.set(KEY, this.state);
    await this.repos.audit.append({ id: uuid(), ts: this.clock.now(), actor, action: 'KILL_SWITCH_RELEASED', details: { previous: prev, note } });
    log.warn({ actor, note }, 'kill switch released');
    this.listeners.forEach((l) => l(this.get()));
  }

  /** Called periodically; releases a DAILY_LOSS halt after UTC rollover. */
  async tick(): Promise<void> {
    if (this.state.engaged && this.state.kind === 'DAILY_LOSS' && this.state.autoReleaseAt && this.clock.now() >= this.state.autoReleaseAt) {
      await this.release('system', 'daily loss halt expired at UTC rollover');
    }
  }
}
