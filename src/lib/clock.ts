/** Injectable clock so backtests/tests run deterministically against simulated time. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export class SimulatedClock implements Clock {
  constructor(private t: number) {}
  now(): number {
    return this.t;
  }
  set(t: number): void {
    if (t < this.t) throw new Error('SimulatedClock cannot move backwards');
    this.t = t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
  }
}

export const MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
export const YEAR_MS = 365 * MS.d;
