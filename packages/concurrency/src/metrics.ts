import { monoNow } from './time.js';

export interface LatencySummary {
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
  readonly p999: number;
}

/**
 * An exact latency recorder over retained samples.
 *
 * Deliberately not an approximate histogram (HDR, t-digest): the stress suites
 * record at most a few hundred thousand samples per run, exactness costs a few
 * megabytes, and a tail percentile computed from bucket midpoints is precisely
 * the number you cannot trust when you are trying to prove a p99.
 *
 * Samples are milliseconds from a monotonic clock, so a system clock adjustment
 * mid-run cannot produce a negative latency.
 */
export class LatencyRecorder {
  private samples: number[] = [];
  private sorted = false;

  constructor(readonly name = 'latency') {}

  get count(): number {
    return this.samples.length;
  }

  record(ms: number): void {
    this.samples.push(ms);
    this.sorted = false;
  }

  /** Time `fn`, recording its duration whether it resolves or rejects. */
  async time<T>(fn: () => Promise<T>): Promise<T> {
    const start = monoNow();
    try {
      return await fn();
    } finally {
      this.record(monoNow() - start);
    }
  }

  /** Start a manual span; returns a function that records on call. */
  start(): () => number {
    const begin = monoNow();
    return () => {
      const elapsed = monoNow() - begin;
      this.record(elapsed);
      return elapsed;
    };
  }

  reset(): void {
    this.samples = [];
    this.sorted = false;
  }

  percentile(p: number): number {
    if (this.samples.length === 0) return NaN;
    this.ensureSorted();
    // Nearest-rank: the smallest value at or above which p% of samples fall.
    const rank = Math.ceil((p / 100) * this.samples.length);
    return this.samples[Math.min(this.samples.length - 1, Math.max(0, rank - 1))]!;
  }

  summary(): LatencySummary {
    if (this.samples.length === 0) {
      return { count: 0, min: NaN, max: NaN, mean: NaN, p50: NaN, p90: NaN, p99: NaN, p999: NaN };
    }
    this.ensureSorted();
    const sum = this.samples.reduce((a, b) => a + b, 0);
    return {
      count: this.samples.length,
      min: this.samples[0]!,
      max: this.samples[this.samples.length - 1]!,
      mean: sum / this.samples.length,
      p50: this.percentile(50),
      p90: this.percentile(90),
      p99: this.percentile(99),
      p999: this.percentile(99.9),
    };
  }

  format(): string {
    const s = this.summary();
    if (s.count === 0) return `${this.name}: no samples`;
    const f = (n: number) => `${n.toFixed(3)}ms`;
    return (
      `${this.name}: n=${s.count} min=${f(s.min)} p50=${f(s.p50)} ` +
      `p90=${f(s.p90)} p99=${f(s.p99)} p99.9=${f(s.p999)} max=${f(s.max)}`
    );
  }

  private ensureSorted(): void {
    if (this.sorted) return;
    this.samples.sort((a, b) => a - b);
    this.sorted = true;
  }
}

/** Named counters. Cheap enough to leave on in production. */
export class Counters {
  private readonly values = new Map<string, number>();

  inc(name: string, by = 1): void {
    this.values.set(name, (this.values.get(name) ?? 0) + by);
  }

  get(name: string): number {
    return this.values.get(name) ?? 0;
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.values);
  }

  reset(): void {
    this.values.clear();
  }
}
