/**
 * Alerting: persisted alert records + structured logs + optional webhook (Slack/Discord/Telegram-bridge
 * compatible JSON `{text}`), with per-code de-duplication to avoid alert storms.
 */
import { EventEmitter } from 'node:events';
import type { Repositories, AlertRecord } from '../persistence/ports.js';
import { uuid } from '../lib/ids.js';
import { childLogger } from '../lib/logger.js';
import type { Clock } from '../lib/clock.js';

const log = childLogger('alerts');
const LEVELS = ['info', 'warn', 'error', 'critical'] as const;
export type AlertLevel = (typeof LEVELS)[number];

export class Alerts extends EventEmitter {
  private lastSent = new Map<string, number>();
  constructor(
    private readonly repos: Repositories,
    private readonly clock: Clock,
    private readonly webhookUrl?: string,
    private readonly minLevel: AlertLevel = 'warn',
    private readonly dedupeMs = 5 * 60_000,
  ) {
    super();
  }

  async raise(level: AlertLevel, code: string, message: string, details?: Record<string, unknown>): Promise<void> {
    const now = this.clock.now();
    const key = `${level}:${code}`;
    const last = this.lastSent.get(key);
    if (last !== undefined && now - last < this.dedupeMs) return;
    this.lastSent.set(key, now);
    // Survive tsx-watch / second-process restarts: in-memory lastSent is empty, Mongo is not.
    try {
      const recent = await this.repos.alerts.recent({ limit: 50 });
      if (recent.some((a) => a.code === code && !a.acknowledged)) return;
    } catch (e) {
      log.warn({ err: (e as Error).message, code }, 'alert dedupe lookup failed; inserting');
    }
    const rec: AlertRecord = { id: uuid(), ts: now, level, code, message, details, acknowledged: false };
    log[level === 'critical' ? 'fatal' : level === 'info' ? 'info' : level]({ code, details }, message);
    try {
      await this.repos.alerts.insert(rec);
    } catch (e) {
      log.error({ err: (e as Error).message }, 'failed to persist alert');
    }
    this.emit('alert', rec);
    if (this.webhookUrl && LEVELS.indexOf(level) >= LEVELS.indexOf(this.minLevel)) {
      const text = `[${level.toUpperCase()}] ${code}: ${message}`;
      fetch(this.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, content: text }) }).catch((e) =>
        log.warn({ err: (e as Error).message }, 'alert webhook failed'),
      );
    }
  }
}
