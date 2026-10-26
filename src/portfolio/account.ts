/**
 * Account bookkeeping per mode: cash, peak equity, day-start equity, loss streaks. PAPER cash is
 * fully simulated from fills; LIVE cash comes from the exchange wallet (reconciled), with our own
 * mark-to-market of open positions added for equity.
 */
import type { Mode, Position } from '../domain/types.js';
import type { Repositories } from '../persistence/ports.js';
import type { Clock } from '../lib/clock.js';
import type { AccountState } from '../risk/engine.js';

export interface AccountBook {
  mode: Mode;
  cash: number;
  peakEquity: number;
  dayStartEquity: number;
  day: number;
  realizedPnlToday: number;
  consecutiveLosses: number;
  lastLossAt?: number;
  totalFees: number;
  totalFunding: number;
}

const key = (m: Mode) => `account.${m}`;
const utcDay = (t: number) => Math.floor(t / 86_400_000);

export class Account {
  book: AccountBook;
  constructor(private readonly repos: Repositories, private readonly clock: Clock, readonly mode: Mode, private readonly startingBalance: number) {
    this.book = this.fresh();
  }

  private fresh(): AccountBook {
    return {
      mode: this.mode,
      cash: this.startingBalance,
      peakEquity: this.startingBalance,
      dayStartEquity: this.startingBalance,
      day: utcDay(this.clock.now()),
      realizedPnlToday: 0,
      consecutiveLosses: 0,
      totalFees: 0,
      totalFunding: 0,
    };
  }

  async load(): Promise<AccountBook> {
    const saved = await this.repos.state.get<AccountBook>(key(this.mode));
    this.book = saved ?? this.fresh();
    return this.book;
  }

  async save(): Promise<void> {
    await this.repos.state.set(key(this.mode), this.book);
  }

  /** Roll the trading day and update the high-water mark. */
  async observeEquity(equity: number): Promise<void> {
    const d = utcDay(this.clock.now());
    let dirty = false;
    if (d !== this.book.day) {
      this.book.day = d;
      this.book.dayStartEquity = equity;
      this.book.realizedPnlToday = 0;
      dirty = true;
    }
    if (equity > this.book.peakEquity) {
      this.book.peakEquity = equity;
      dirty = true;
    }
    if (dirty) await this.save();
  }

  /** PAPER: apply the cash effect of a fill. qtyUnits already includes contract size. */
  applyCash(delta: number, fee: number): void {
    this.book.cash += delta - fee;
    this.book.totalFees += fee;
  }

  applyFunding(amount: number): void {
    this.book.cash -= amount;
    this.book.totalFunding += amount;
  }

  async recordClosedTrade(pnl: number): Promise<void> {
    this.book.realizedPnlToday += pnl;
    if (pnl < 0) {
      this.book.consecutiveLosses++;
      this.book.lastLossAt = this.clock.now();
    } else {
      this.book.consecutiveLosses = 0;
    }
    await this.save();
  }

  /** LIVE: overwrite cash from the exchange wallet after reconciliation. */
  async syncCash(cash: number): Promise<void> {
    this.book.cash = cash;
    await this.save();
  }

  /** Operator reset (PAPER only): start a fresh paper account. */
  async reset(balance: number): Promise<void> {
    if (this.mode !== 'PAPER') throw new Error('only PAPER accounts can be reset');
    const now = this.clock.now();
    this.book = { mode: 'PAPER', cash: balance, peakEquity: balance, dayStartEquity: balance, day: utcDay(now), realizedPnlToday: 0, consecutiveLosses: 0, totalFees: 0, totalFunding: 0 };
    await this.save();
  }

  snapshot(equity: number, marginInUse: number, open: Position[], ordersLastMinute: number, kill: { engaged: boolean; reason?: string }): AccountState {
    return {
      mode: this.mode,
      equity,
      cash: this.book.cash,
      marginInUse,
      peakEquity: Math.max(this.book.peakEquity, equity),
      dayStartEquity: this.book.dayStartEquity,
      realizedPnlToday: this.book.realizedPnlToday,
      openPositions: open,
      consecutiveLosses: this.book.consecutiveLosses,
      lastLossAt: this.book.lastLossAt,
      ordersLastMinute,
      killSwitch: kill,
    };
  }
}
