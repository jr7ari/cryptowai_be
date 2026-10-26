/** Tiny Prometheus text-format registry (no external dependency). */
type Labels = Record<string, string>;

const key = (name: string, labels?: Labels) =>
  labels && Object.keys(labels).length
    ? `${name}{${Object.entries(labels)
        .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`)
        .join(',')}}`
    : name;

export class Metrics {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private help = new Map<string, { type: 'counter' | 'gauge'; text: string }>();

  describe(name: string, type: 'counter' | 'gauge', text: string) {
    this.help.set(name, { type, text });
  }
  inc(name: string, labels?: Labels, by = 1) {
    const k = key(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + by);
  }
  set(name: string, value: number, labels?: Labels) {
    if (Number.isFinite(value)) this.gauges.set(key(name, labels), value);
  }
  render(): string {
    const lines: string[] = [];
    for (const [name, h] of this.help) lines.push(`# HELP ${name} ${h.text}`, `# TYPE ${name} ${h.type}`);
    for (const [k, v] of this.counters) lines.push(`${k} ${v}`);
    for (const [k, v] of this.gauges) lines.push(`${k} ${v}`);
    return lines.join('\n') + '\n';
  }
}

export const metrics = new Metrics();
metrics.describe('engine_decisions_total', 'counter', 'Decisions taken by action');
metrics.describe('engine_orders_total', 'counter', 'Orders by status');
metrics.describe('engine_equity', 'gauge', 'Account equity by mode');
metrics.describe('engine_drawdown_pct', 'gauge', 'Drawdown from peak by mode');
metrics.describe('engine_open_positions', 'gauge', 'Open positions by mode');
metrics.describe('engine_data_age_ms', 'gauge', 'Market data age per symbol');
metrics.describe('engine_regime_confidence', 'gauge', 'Primary regime confidence per symbol');
metrics.describe('engine_kill_switch', 'gauge', '1 if kill switch engaged');
