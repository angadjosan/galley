/**
 * Shared plumbing for the `agent-lat4-*` saturation campaign.
 *
 * Not a test file: `vitest.config.ts` only collects `*.test.ts`.
 *
 * The one thing worth explaining is how the CPU is taken away. `Hog` burns a
 * fixed slice of wall clock in a tight loop and then yields with
 * `setImmediate`, so the event loop's poll phase still runs — I/O is *starved*,
 * not blocked. That is what an overloaded server actually looks like: work
 * arrives, it just waits behind other work. A loop that never yielded would
 * measure "Node is single threaded", which nobody needed a test for.
 *
 * Duty cycle is reported from `performance.eventLoopUtilization()` rather than
 * assumed, because a hog that yields for 0.2 ms and one that yields for 4 ms
 * are different experiments and the difference is invisible in the source.
 */
import { performance, type EventLoopUtilization } from 'node:perf_hooks';
import { LatencyRecorder, monoNow, delay } from '@galley/concurrency';

/** A competing CPU load that yields between slices so I/O can still land. */
export class Hog {
  private running = false;
  private slices = 0;
  private burnedMs = 0;

  constructor(readonly sliceMs = 20) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = (): void => {
      if (!this.running) return;
      const begin = monoNow();
      const end = begin + this.sliceMs;
      // A real spin. `Atomics.wait` or a sleep would yield the thread, which is
      // the opposite of the thing being simulated.
      while (monoNow() < end) {
        /* burn */
      }
      this.slices++;
      this.burnedMs += monoNow() - begin;
      setImmediate(loop);
    };
    setImmediate(loop);
  }

  stop(): void {
    this.running = false;
  }

  get stats(): { slices: number; burnedMs: number } {
    return { slices: this.slices, burnedMs: this.burnedMs };
  }
}

/** Fraction of wall clock the loop spent busy between two ELU samples. */
export function utilizationSince(previous: EventLoopUtilization): number {
  return performance.eventLoopUtilization(performance.eventLoopUtilization(), previous).utilization;
}

export function eluMark(): EventLoopUtilization {
  return performance.eventLoopUtilization();
}

/**
 * Timer lag: how late a `setTimeout(0)` fires.
 *
 * Every timeout in this codebase — `Deadline`, `withTimeout`, the channel and
 * mutex acquire timers, the persist debounce, the presence coalescer — is a
 * `setTimeout`. Under saturation they all inherit this number, so it is the
 * single figure that says whether the system's own deadlines still mean
 * anything.
 */
export async function measureTimerLag(samples: number, gapMs = 2): Promise<LatencyRecorder> {
  const rec = new LatencyRecorder('timer-lag');
  for (let i = 0; i < samples; i++) {
    const scheduled = monoNow();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    rec.record(monoNow() - scheduled);
    await delay(gapMs);
  }
  return rec;
}

export interface Phase {
  readonly label: string;
  readonly latency: LatencyRecorder;
  readonly errors: Map<string, number>;
  readonly wallMs: number;
  readonly utilization: number;
}

/** Run `n` sequential operations, timing each and bucketing failures by kind. */
export async function phase(
  label: string,
  n: number,
  op: (i: number) => Promise<string | null>,
): Promise<Phase> {
  const latency = new LatencyRecorder(label);
  const errors = new Map<string, number>();
  const mark = eluMark();
  const began = monoNow();
  for (let i = 0; i < n; i++) {
    const started = monoNow();
    let kind: string | null = null;
    try {
      kind = await op(i);
    } catch (err) {
      kind = `throw:${err instanceof Error ? err.name : 'unknown'}`;
    }
    latency.record(monoNow() - started);
    if (kind) errors.set(kind, (errors.get(kind) ?? 0) + 1);
  }
  return {
    label,
    latency,
    errors,
    wallMs: monoNow() - began,
    utilization: utilizationSince(mark),
  };
}

export function report(p: Phase): void {
  const s = p.latency.summary();
  const f = (n: number) => n.toFixed(2).padStart(9);
  console.log(
    `  ${p.label.padEnd(26)} n=${String(s.count).padStart(4)} ` +
      `p50=${f(s.p50)} p90=${f(s.p90)} p99=${f(s.p99)} max=${f(s.max)} ` +
      `elu=${(p.utilization * 100).toFixed(1)}% ` +
      `${p.errors.size ? JSON.stringify(Object.fromEntries(p.errors)) : ''}`,
  );
}

/** A document with `blocks` paragraphs, big enough that work is measurable. */
export function bigDoc(blocks: number): string {
  const out: string[] = ['# Load document', ''];
  for (let i = 0; i < blocks; i++) {
    out.push(
      `Paragraph ${i} of the load document, carrying enough words that parsing ` +
        `it is real work and not a rounding error on the measurement.`,
      '',
    );
  }
  return out.join('\n');
}
