/**
 * Adversarial re-anchoring.
 *
 * The gate from `idea.md` is asymmetric and this file takes it literally:
 * **orphaning is always acceptable, a wrong non-null match never is.** Losing a
 * comment shows up in an orphan tray where a human fixes it; attaching it to the
 * wrong paragraph is silent and permanent.
 *
 * So nothing here asserts a survival rate. Every test asserts zero
 * misattachments against documents engineered to make one likely: runs of
 * near-identical paragraphs, blocks that swap places, a block overwritten with a
 * copy of its neighbour, and content moved between headings that share a name.
 *
 * Ground truth is carried in the text itself. Every generated paragraph is
 * `Section T<n>: <body>`, so the block a resolution landed on can be checked
 * against the anchor it came from without the matcher ever being handed the
 * answer — the token is a few characters inside a long sentence, far too small
 * for the trigram similarity to key on.
 */
import { describe, expect, it } from 'vitest';
import { makeRng } from '@galley/concurrency';
import { parseDocument } from '@galley/markdown';
import { fingerprintDocument, reanchor, type Anchor } from '@galley/anchor';

const TOPICS = [
  'the refund window is thirty calendar days measured from the delivery date',
  'the cancellation window is two hours measured from the moment of placement',
  'idempotency keys are required on every mutating request to the payments API',
  'currency codes follow ISO 4217 and are validated against the supported list',
  'amounts are expressed in minor units and must be strictly positive integers',
  'webhook deliveries retry with exponential backoff for up to twenty four hours',
  'the audit log records the principal, the resource, and the outcome of the call',
  'rate limits are enforced per organisation rather than per API credential',
];

const TAIL = /^Section (T\d+):/;
const tagOf = (text: string): string | null => TAIL.exec(text.trim())?.[1] ?? null;

interface Item {
  tag: number;
  topic: number;
  reword: number;
}

function bodyFor(item: Item): string {
  const base = TOPICS[item.topic % TOPICS.length]!;
  switch (item.reword) {
    case 1:
      return base.replace(/ the /g, ' each ');
    case 2:
      return `note that ${base}, which the team confirmed during the last review meeting`;
    case 3:
      return base.split(' ').slice(0, 8).join(' ');
    default:
      return base;
  }
}

/** Render items as a document with repeating heading names, three per section. */
function build(items: readonly Item[], headings = ['Setup', 'Setup', 'Notes']): string {
  const out = ['# Doc', ''];
  items.forEach((item, i) => {
    if (i % 3 === 0) out.push(`## ${headings[((i / 3) | 0) % headings.length]}`, '');
    out.push(`Section T${item.tag}: ${bodyFor(item)}.`, '');
  });
  return out.join('\n');
}

/** Anchors keyed by their ground-truth tag, taken from the *before* document. */
function anchorsOf(source: string): Anchor[] {
  const doc = parseDocument(source);
  const prints = fingerprintDocument(doc);
  const out: Anchor[] = [];
  doc.blocks.forEach((block, index) => {
    const tag = tagOf(block.text);
    if (block.type === 'paragraph' && tag) out.push({ id: tag, fingerprint: prints[index]! });
  });
  return out;
}

interface Misattachment {
  anchorId: string;
  landedOn: string | null;
  method: string;
  confidence: number;
  runnerUp: number;
}

/** Every resolution that landed on a block carrying somebody else's tag. */
function misattachments(anchors: readonly Anchor[], after: string): Misattachment[] {
  const doc = parseDocument(after);
  const result = reanchor(anchors, doc);
  const out: Misattachment[] = [];
  for (const r of result.resolutions) {
    if (r.blockIndex === null) continue; // orphaning is always acceptable
    const landedOn = tagOf(doc.blocks[r.blockIndex]!.text);
    if (landedOn !== r.anchorId) {
      out.push({
        anchorId: r.anchorId,
        landedOn,
        method: r.method,
        confidence: r.confidence,
        runnerUp: r.runnerUp,
      });
    }
  }
  return out;
}

function describeAll(found: readonly Misattachment[]): string {
  return found
    .map(
      (m) =>
        `anchor ${m.anchorId} -> block tagged ${m.landedOn} (method ${m.method}, confidence ${m.confidence.toFixed(3)}, runner-up ${m.runnerUp.toFixed(3)})`,
    )
    .join('\n');
}

describe('handwritten adversarial documents', () => {
  // Claim: eight paragraphs differing only by an index, one deleted. Every
  // anchor must land on its own paragraph or orphan; none may slide by one.
  it('does not shift anchors when one of many near-identical paragraphs is deleted', () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ tag: i, topic: 0, reword: 0 }));
    const before = build(items);
    const after = build(items.filter((_, i) => i !== 3));
    expect(describeAll(misattachments(anchorsOf(before), after))).toBe('');
  });

  // Claim: two blocks trade places. Identity follows content, not position.
  it('follows content when two blocks swap places', () => {
    const items = [
      { tag: 0, topic: 0, reword: 0 },
      { tag: 1, topic: 5, reword: 0 },
    ];
    const before = build(items);
    const after = build([items[1]!, items[0]!]);
    expect(describeAll(misattachments(anchorsOf(before), after))).toBe('');
  });

  // Claim: a block overwritten with a copy of its neighbour. The overwritten
  // block's anchor has nothing of its own left, so it must orphan rather than
  // claim the copy that now sits where it used to.
  it('orphans an anchor whose block was overwritten by a copy of its neighbour', () => {
    const items = [
      { tag: 0, topic: 0, reword: 0 },
      { tag: 1, topic: 3, reword: 0 },
      { tag: 2, topic: 6, reword: 0 },
    ];
    const before = build(items);
    const after = build([items[0]!, { ...items[0]!, tag: 1 }, items[2]!].map((x) => x));
    const found = misattachments(anchorsOf(before), after).filter((m) => m.anchorId === 'T1');
    expect(describeAll(found)).toBe('');
  });

  // Claim: two `## Setup` sections whose bodies trade places. The heading path
  // is identical for both, so only content may decide, and it must decide right.
  it('does not confuse content moved between identically-named headings', () => {
    const before = [
      '# Doc',
      '',
      '## Setup',
      '',
      'Section T0: install the toolchain and configure the environment variables first.',
      '',
      '## Notes',
      '',
      'Section T1: filler paragraph that exists only to separate the two sections.',
      '',
      '## Setup',
      '',
      'Section T2: run the migration script against the staging database now.',
      '',
    ].join('\n');
    const after = before
      .replace('Section T0: install', 'Section TMP: install')
      .replace('Section T2: run', 'Section T0: run')
      .replace('Section TMP: install', 'Section T2: install');
    // T0's sentence moved into the second Setup section and vice versa; each
    // anchor must follow its sentence, not its heading.
    const doc = parseDocument(after);
    const result = reanchor(anchorsOf(before), doc);
    const bad: string[] = [];
    for (const r of result.resolutions) {
      if (r.blockIndex === null) continue;
      const text = doc.blocks[r.blockIndex]!.text;
      const expected = r.anchorId === 'T0' ? 'install' : r.anchorId === 'T2' ? 'run' : 'filler';
      if (!text.includes(expected)) {
        bad.push(`${r.anchorId} landed on ${JSON.stringify(text)} (method ${r.method})`);
      }
    }
    expect(bad.join('\n')).toBe('');
  });

  // Claim: a paragraph split in two halves, each equally similar to the
  // original, must orphan rather than pick the half that kept the old position.
  it('orphans when a paragraph is split into two equal halves', () => {
    const before =
      '# T\n\nThe API accepts a currency code and an amount. The amount is in minor units and must be a positive integer value.\n';
    const after =
      '# T\n\nThe API accepts a currency code and an amount.\n\nThe amount is in minor units and must be a positive integer value.\n';
    const doc = parseDocument(before);
    const prints = fingerprintDocument(doc);
    const index = doc.blocks.findIndex((b) => b.type === 'paragraph');
    const result = reanchor([{ id: 'split', fingerprint: prints[index]! }], parseDocument(after));
    expect(result.resolutions[0]!.blockIndex, 'a split paragraph must orphan').toBe(null);
  });

  // Claim: a block whose content was replaced outright must orphan. Position,
  // heading and neighbours all still agree, so only the text floor can stop it.
  it('orphans when a block’s content is replaced outright', () => {
    const before = '# T\n\nThe refund window is thirty days from the delivery date of the order.\n';
    const after = '# T\n\nQuarterly revenue increased by twelve percent across the EMEA region.\n';
    const doc = parseDocument(before);
    const prints = fingerprintDocument(doc);
    const index = doc.blocks.findIndex((b) => b.type === 'paragraph');
    const result = reanchor([{ id: 'gone', fingerprint: prints[index]! }], parseDocument(after));
    expect(result.resolutions[0]!.blockIndex).toBe(null);
  });

  // Claim: type is a hard gate. A heading and a paragraph with the same words
  // are not the same block however similar their text.
  it('never matches a heading to a paragraph with the same words', () => {
    const before = '# Doc\n\n## The migration plan for the payments service\n\nfiller text here\n';
    const after = '# Doc\n\nThe migration plan for the payments service\n\nfiller text here\n';
    const doc = parseDocument(before);
    const prints = fingerprintDocument(doc);
    const index = doc.blocks.findIndex((b) => b.type === 'heading' && b.text.includes('migration'));
    const target = parseDocument(after);
    const result = reanchor([{ id: 'h', fingerprint: prints[index]! }], target);
    const landed = result.resolutions[0]!.blockIndex;
    if (landed !== null) expect(target.blocks[landed]!.type).toBe('heading');
  });

  // Claim: a marker that survives is authoritative and needs no inference, even
  // when the block's content changed beyond recognition.
  it('honours a surviving marker over any amount of content drift', () => {
    const before = 'A paragraph about invoicing and settlement timing. <!-- ^keep01 -->\n';
    const after = 'Something entirely different now lives here. <!-- ^keep01 -->\n';
    const doc = parseDocument(before);
    const prints = fingerprintDocument(doc);
    const result = reanchor([{ id: 'keep01', fingerprint: prints[0]! }], parseDocument(after));
    expect(result.resolutions[0]!.method).toBe('marker');
    expect(result.resolutions[0]!.blockIndex).toBe(0);
  });

  // Claim: an empty anchor set and an empty document are handled, not crashed.
  it('handles degenerate inputs', () => {
    expect(reanchor([], parseDocument('')).survivalRate).toBe(1);
    const doc = parseDocument('# T\n\nBody.\n');
    const prints = fingerprintDocument(doc);
    expect(reanchor([{ id: 'x', fingerprint: prints[1]! }], parseDocument('')).orphans).toHaveLength(
      1,
    );
  });
});

describe('randomized adversarial re-anchoring', () => {
  const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

  // Claim: across three hundred randomly generated documents full of
  // near-duplicates, subjected to deletes, swaps, shuffles, rewordings,
  // duplications and neighbour-clobbering, **not one anchor lands on a block
  // that is not its own**. Survival is not asserted; only correctness is.
  //
  // The one shape that does misattach — a near-identical twin whose partner was
  // deleted — is excluded here and pinned as a KNOWN BUG below, so this test
  // stays a live gate for everything else.
  it('never produces a misattachment', () => {
    const failures: string[] = [];
    let matched = 0;
    let orphaned = 0;

    for (const seed of SEEDS) {
      const rng = makeRng(seed);
      const count = 6 + rng.int(8);
      // Topics are drawn from a deliberately small pool, so near-duplicate
      // paragraphs are the norm rather than the exception.
      const items: Item[] = Array.from({ length: count }, (_, i) => ({
        tag: i,
        topic: rng.int(4),
        reword: 0,
      }));
      const before = build(items);

      const after = items.map((x) => ({ ...x }));
      const mutation = rng.int(6);
      switch (mutation) {
        case 0:
          after.splice(rng.int(after.length), 1);
          break;
        case 1: {
          const a = rng.int(after.length);
          const b = rng.int(after.length);
          [after[a], after[b]] = [after[b]!, after[a]!];
          break;
        }
        case 2: {
          // Clobber a block with a copy of its neighbour.
          const a = rng.int(after.length - 1);
          after[a + 1] = { ...after[a]!, tag: after[a + 1]!.tag };
          break;
        }
        case 3:
          rng.shuffle(after);
          break;
        case 4:
          after[rng.int(after.length)]!.reword = 1 + rng.int(3);
          break;
        default: {
          const a = rng.int(after.length);
          after.splice(a, 0, { ...after[a]! });
          break;
        }
      }

      const anchors = anchorsOf(before);
      const doc = parseDocument(build(after));
      const result = reanchor(anchors, doc);

      // Which tags still exist in the after-document, so "the twin survived
      // alone" can be told apart from a genuine mismatch.
      const survivingTags = new Set(after.map((x) => `T${x.tag}`));

      for (const r of result.resolutions) {
        if (r.blockIndex === null) {
          orphaned++;
          continue;
        }
        matched++;
        const landedOn = tagOf(doc.blocks[r.blockIndex]!.text);
        if (landedOn === r.anchorId) continue;
        if (!survivingTags.has(r.anchorId)) {
          // The anchor's own block is gone and it attached to a near-identical
          // survivor. Pinned separately; see the KNOWN BUG below.
          continue;
        }
        failures.push(
          `seed ${seed} (mutation ${mutation}): anchor ${r.anchorId} -> block tagged ${landedOn}, method ${r.method}, confidence ${r.confidence.toFixed(3)}, runner-up ${r.runnerUp.toFixed(3)}`,
        );
      }
    }

    expect(
      failures.slice(0, 10).join('\n'),
      `${failures.length} misattachment(s) across ${SEEDS.length} seeds (${matched} matched, ${orphaned} orphaned)`,
    ).toBe('');
  });

  // Claim: whatever else it does, re-anchoring is one-to-one. Two anchors must
  // never resolve to the same block.
  it('assigns at most one anchor to any block', () => {
    for (const seed of SEEDS.slice(0, 60)) {
      const rng = makeRng(seed);
      const count = 5 + rng.int(6);
      const items: Item[] = Array.from({ length: count }, (_, i) => ({
        tag: i,
        topic: rng.int(3),
        reword: 0,
      }));
      const after = items.map((x) => ({ ...x }));
      rng.shuffle(after);
      const doc = parseDocument(build(after));
      const result = reanchor(anchorsOf(build(items)), doc);
      const claimed = result.resolutions
        .map((r) => r.blockIndex)
        .filter((i): i is number => i !== null);
      expect(new Set(claimed).size, `seed ${seed}: a block was claimed twice`).toBe(claimed.length);
    }
  });

  // Claim: an unchanged document whose paragraphs are all *distinct* re-anchors
  // at full survival. If this ever fails the matcher has become useless.
  it('re-anchors an unchanged document of distinct paragraphs at full survival', () => {
    for (const seed of SEEDS.slice(0, 40)) {
      const rng = makeRng(seed);
      // One topic each, no repeats: nothing here is ambiguous by any measure.
      const topics = rng.shuffle([...TOPICS.keys()]).slice(0, 6);
      const items: Item[] = topics.map((topic, i) => ({ tag: i, topic, reword: 0 }));
      const source = build(items);
      const result = reanchor(anchorsOf(source), parseDocument(source));
      expect(result.survivalRate, `seed ${seed}`).toBe(1);
      expect(describeAll(misattachments(anchorsOf(source), source))).toBe('');
    }
  });
});

/**
 * ============================================================================
 * KNOWN BUGS.
 * ============================================================================
 */
describe('KNOWN BUG: an unedited document orphans every anchor when paragraphs repeat', () => {
  // `Fingerprint.textHash` is documented as the "Exact-match fast path"
  // (packages/anchor/src/fingerprint.ts:19) but `scorePair`
  // (packages/anchor/src/reanchor.ts:276) never reads it. Nothing in the
  // pipeline distinguishes "this is literally the same text" from "this is very
  // similar text", so a run of near-identical paragraphs is ambiguous even when
  // an exact match exists — and the ambiguity margin then orphans all of them.
  //
  // The document below has not been edited at all. Re-anchoring it against
  // itself returns a survival rate of **zero**, with a self-match confidence of
  // 1.000. `reanchor.ts:41` states the gate as ">=95% survival across a corpus
  // of realistic agent rewrites"; this is 0% across no rewrite whatsoever.
  const runbook =
    '# Runbook\n\n' +
    'Step 1: restart the payment service and confirm the health endpoint is green.\n\n' +
    'Step 2: restart the payment service and confirm the health endpoint is green.\n\n' +
    'Step 3: restart the payment service and confirm the health endpoint is green.\n';

  function selfAnchor() {
    const doc = parseDocument(runbook);
    const prints = fingerprintDocument(doc);
    const anchors = doc.blocks
      .map((block, index) => ({ block, index }))
      .filter(({ block }) => block.type === 'paragraph')
      .map(({ block, index }) => ({ id: block.text.slice(0, 6), fingerprint: prints[index]! }));
    return reanchor(anchors, parseDocument(runbook));
  }

  it.fails('keeps every anchor when the document did not change', () => {
    expect(selfAnchor().survivalRate).toBe(1);
  });

  it('demonstrates the defect concretely', () => {
    const result = selfAnchor();
    expect(result.survivalRate).toBe(0);
    expect(result.resolutions.map((r) => r.method)).toEqual([
      'orphan-ambiguous',
      'orphan-ambiguous',
      'orphan-ambiguous',
    ]);
    // The best candidate for the first anchor is a perfect self-match, and it
    // is thrown away anyway.
    expect(result.resolutions[0]!.confidence).toBeCloseTo(1, 10);
    // The text hashes are distinct, so an exact-match pass would resolve all
    // three unambiguously.
    const prints = fingerprintDocument(parseDocument(runbook));
    const hashes = prints.filter((_, i) => i > 0).map((p) => p.textHash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});

describe('KNOWN BUG: an anchor jumps to a near-identical twin when its own block is deleted', () => {
  // The ambiguity guard compares a candidate against the *other candidates that
  // still exist*. When a document contains two near-identical paragraphs and
  // one of them is deleted, the deleted one's anchor sees exactly one strong
  // candidate — its twin — with a runner-up of zero, so both the combined and
  // the text margin are satisfied and it attaches with high confidence.
  //
  // This is the case `fingerprint.ts` names in its own header ("two short
  // identical paragraphs collide by construction") and it is precisely the
  // silent misattachment the gate forbids: a comment written about step 4 is
  // now attached to step 5, with no orphan and no warning.
  //
  // packages/anchor/src/reanchor.ts:214 — `bestOtherText` and the runner-up are
  // both computed over surviving blocks only, so a vanished twin leaves no
  // trace to be ambiguous against.
  const before =
    '# Runbook\n\n' +
    'Step 4: restart the payment service and confirm the health endpoint is green.\n\n' +
    'Step 5: restart the payment service and confirm the health endpoint is green.\n';
  const after =
    '# Runbook\n\n' +
    'Step 5: restart the payment service and confirm the health endpoint is green.\n';

  function resolveStep4() {
    const doc = parseDocument(before);
    const prints = fingerprintDocument(doc);
    const index = doc.blocks.findIndex((b) => b.text.startsWith('Step 4'));
    return reanchor([{ id: 'comment-on-step-4', fingerprint: prints[index]! }], parseDocument(after))
      .resolutions[0]!;
  }

  it.fails('orphans rather than attaching to the surviving twin', () => {
    expect(resolveStep4().blockIndex).toBe(null);
  });

  it('demonstrates the defect concretely', () => {
    const r = resolveStep4();
    // Today it attaches, as `fuzzy`, with high confidence and a zero runner-up.
    expect(r.method).toBe('fuzzy');
    expect(r.blockIndex).toBe(1);
    expect(r.confidence).toBeGreaterThan(0.8);
    expect(r.runnerUp).toBe(0);
    expect(parseDocument(after).blocks[r.blockIndex!]!.text).toContain('Step 5');
  });
});
