import { parseDocument } from '@galley/markdown';
import type { DocumentActor } from '@galley/core';

/**
 * The invariants every stress run asserts, continuously.
 *
 * Checking them *during* the storm rather than only after it is the point: a
 * system that is momentarily inconsistent and settles is indistinguishable from
 * a correct one at the end, and the moment of inconsistency is exactly when a
 * reader would have seen a broken document.
 */
export interface Violation {
  readonly at: number;
  readonly invariant: string;
  readonly detail: string;
}

export interface InvariantOptions {
  /** Text fragments that must appear exactly once each, once written. */
  expectOnce?: () => readonly string[];
}

export function checkDocument(actor: DocumentActor, options: InvariantOptions = {}): Violation[] {
  const violations: Violation[] = [];
  const at = Date.now();
  const record = (invariant: string, detail: string): void => {
    violations.push({ at, invariant, detail });
  };

  const markdown = actor.document.toMarkdown();

  // 1. The document always parses. A storm must never leave bytes on disk that
  //    the parser cannot read back.
  let parsed;
  try {
    parsed = parseDocument(markdown);
  } catch (err) {
    record('parses', `document failed to parse: ${err instanceof Error ? err.message : String(err)}`);
    return violations;
  }

  // 2. Round-trip: the CRDT's bytes and the parser's view agree.
  if (parsed.source !== markdown) {
    record('round-trip', 'parse(source).source !== source');
  }

  // 3. Block ids are unique. Two blocks claiming one id means every comment on
  //    it is ambiguous, which is the misattachment failure in another costume.
  const ids = parsed.blocks.map((b) => b.id).filter((id): id is string => id !== null);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) record('unique-ids', `block id ${id} appears more than once`);
    seen.add(id);
  }

  // 4. No block carries two markers. This is what a marker leaking into
  //    replacement content looks like.
  const markerCount = (markdown.match(/<!--\s*\^/g) ?? []).length;
  if (markerCount !== ids.length) {
    record('marker-count', `${markerCount} markers in the text but ${ids.length} identified blocks`);
  }

  // 5. Every live comment points at a block that exists, or is in the tray.
  //    An anchor that is neither is a comment that silently vanished.
  const orphaned = new Set(actor.listOrphans().map((o) => o.anchorId));
  for (const comment of actor.listComments()) {
    const anchorId = comment.anchor.blockId;
    if (!anchorId) continue;
    if (seen.has(anchorId)) continue;
    if (orphaned.has(anchorId) || comment.orphanedAt) continue;
    record('anchor-accounted-for', `comment ${comment.id} anchors to missing block ${anchorId}`);
  }

  // 6. Suggestions are only ever in a defined state, and an accepted one names
  //    who accepted it.
  for (const suggestion of actor.listSuggestions()) {
    if (!['pending', 'accepted', 'rejected', 'stale'].includes(suggestion.state)) {
      record('suggestion-state', `suggestion ${suggestion.id} is in state ${suggestion.state}`);
    }
    if (suggestion.state === 'accepted' && !suggestion.resolvedBy) {
      record('suggestion-state', `accepted suggestion ${suggestion.id} has no resolver`);
    }
  }

  // 7. Content that was written stays written, exactly once.
  for (const fragment of options.expectOnce?.() ?? []) {
    const occurrences = markdown.split(fragment).length - 1;
    if (occurrences !== 1) {
      record('write-once', `${JSON.stringify(fragment)} appears ${occurrences} times, expected 1`);
    }
  }

  // 8. No line acquires trailing whitespace that was not a hard break.
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/[ \t]+$/.test(line) && !/ {2}$/.test(line)) {
      record('no-trailing-space', `line ${i + 1}: ${JSON.stringify(line)}`);
    }
  }

  return violations;
}

/**
 * Poll an invariant while something else runs.
 *
 * Returns a stop function that resolves with every violation seen. Modelled on
 * the balance-conservation pollers in the reference implementation: the poller
 * runs *concurrently* with the storm and asserts on every snapshot.
 */
export function poll(
  check: () => Violation[],
  intervalMs = 5,
): { stop(): Promise<Violation[]>; samples(): number; sample(): void } {
  const violations: Violation[] = [];
  let sampleCount = 0;
  let running = true;

  const take = (): void => {
    violations.push(...check());
    sampleCount++;
  };

  const loop = (async () => {
    while (running) {
      take();
      // `setImmediate` rather than `setTimeout`: a storm that keeps the
      // microtask queue full starves the timer phase, and a poller that never
      // runs during the storm is a poller that proves nothing. The check phase
      // gets a turn on every loop iteration.
      await new Promise((resolve) =>
        intervalMs > 0 ? setTimeout(resolve, intervalMs) : setImmediate(resolve),
      );
    }
  })();

  return {
    async stop(): Promise<Violation[]> {
      running = false;
      await loop;
      take();
      return violations;
    },
    samples: () => sampleCount,
    /** Force a sample now. Used to guarantee coverage mid-storm. */
    sample: take,
  };
}

/**
 * Occupy the CPU for `ms`, synchronously.
 *
 * Deliberately blocking rather than a busy `await` loop: the point of the
 * saturation tests is to starve the event loop, which is what a real server
 * under load experiences and what an async spin would not reproduce.
 */
export function burnCpu(ms: number): number {
  const until = Date.now() + ms;
  let sink = 0;
  while (Date.now() < until) {
    for (let i = 0; i < 20_000; i++) sink += Math.sqrt(i) % 7;
  }
  return sink;
}

/** Fire `fn` repeatedly on a timer, pinning the event loop for `dutyMs` each time. */
export function saturate(dutyMs: number, periodMs: number): () => void {
  const timer = setInterval(() => burnCpu(dutyMs), periodMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
