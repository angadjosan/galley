/**
 * The anchor benchmark — the CI gate from `idea.md`, hard question #3.
 *
 * > **≥95% anchor survival, zero silent misattachments.** A misattachment is a
 * > bug of a different class than an orphan and is never traded off against the
 * > survival rate.
 *
 * The corpus is generated rather than collected, and the generator is the
 * honest part of this file: it simulates the edits an agent actually makes to a
 * document — rewording a paragraph, tightening it, expanding it, retitling a
 * heading, reordering sections, splitting and merging paragraphs, and rewriting
 * a whole section — arriving through the *filesystem*, with no id markers in
 * the payload. That is the hard case. Edits made through `galley suggest` carry
 * identity by construction and are covered separately below.
 *
 * Ground truth is exact: every mutation records which original block became
 * which new block, or that it was deleted. A resolution that points anywhere
 * else is a misattachment, counted separately and gated at zero.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeRng, type Rng } from '@galley/concurrency';
import { parseDocument, type ParsedDocument } from '@galley/markdown';
import { anchorsFor, fingerprintBlock, normalizeText, reanchor, type Anchor } from '../src/index.js';

const CORPUS_DIR = join(import.meta.dirname, '../../../corpus/roundtrip');
/**
 * A *frozen* copy of this repo's design docs.
 *
 * The benchmark used to read them from the repo root, which found real cases —
 * two of the misattachments fixed here came from prose written after the gate
 * was first met. But a gate whose corpus changes every time someone edits a
 * document is not a gate: it can go red on a commit that touched no code, and
 * the first person to see that will assume it is noise.
 *
 * So the corpus is snapshotted. Refresh it deliberately (`cp *.md
 * corpus/prose/`) when you want the newer prose under test, and treat a failure
 * after a refresh as what it is — a real finding on new input.
 */
const PROSE_DIR = join(import.meta.dirname, '../../../corpus/prose');

const DOCUMENTS = [
  ...readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((name) => ({ name, source: readFileSync(join(CORPUS_DIR, name), 'utf8') })),
  ...readdirSync(PROSE_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((name) => ({ name: `prose/${name}`, source: readFileSync(join(PROSE_DIR, name), 'utf8') })),
];

// ---------------------------------------------------------------------------
// The rewrite simulator
// ---------------------------------------------------------------------------

type Mutation =
  | 'reword-light'
  | 'reword-heavy'
  | 'tighten'
  | 'expand'
  | 'split'
  | 'merge'
  | 'delete'
  | 'insert'
  | 'reorder';

interface LogicalBlock {
  /** Stable identity for scoring. Never appears in the emitted Markdown. */
  readonly key: string;
  /**
   * The key of the *original* block this one descends from.
   *
   * Ground truth is tracked by identity rather than by text. The first version
   * recorded each block's fragment texts at split time, which went stale the
   * moment a fragment was reworded — and the matcher got blamed for a
   * bookkeeping error in the generator. Origin cannot go stale.
   */
  readonly origin: string;
  text: string;
  /** True once the block has been removed by a mutation. */
  deleted: boolean;
}

const FILLER = [
  'This paragraph was added by an agent during a rewrite.',
  'The implementation now validates the field before use.',
  'See the validation section for the authoritative rule.',
];

/** Paraphrase without changing meaning — the commonest real agent edit. */
function rewordLight(text: string, rng: Rng): string {
  const swaps: [RegExp, string][] = [
    [/\bmust\b/g, 'has to'],
    [/\bshould\b/g, 'ought to'],
    [/\brequired\b/g, 'mandatory'],
    [/\boptional\b/g, 'not required'],
    [/\bthe\b/g, 'the'],
    [/\ba\b/g, 'a single'],
  ];
  let out = text;
  for (const [pattern, replacement] of swaps) {
    if (rng.chance(0.4)) out = out.replace(pattern, replacement);
  }
  return rng.chance(0.5) ? `${out} ${rng.pick(FILLER)}` : out;
}

/** A substantial rewrite that keeps the topic and little of the wording. */
function rewordHeavy(text: string, rng: Rng): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 6) return `${text} — revised.`;
  const kept = words.filter(() => rng.chance(0.45));
  const head = kept.length > 0 ? kept.join(' ') : words.slice(0, 3).join(' ');
  return `${head} ${rng.pick(FILLER)}`;
}

function tighten(text: string): string {
  const sentences = text.split(/(?<=\.)\s+/);
  return sentences.length > 1 ? sentences.slice(0, -1).join(' ') : text;
}

function expand(text: string, rng: Rng): string {
  return `${text} ${rng.pick(FILLER)} ${rng.pick(FILLER)}`;
}

/**
 * Apply a random mutation set to a document's top-level prose blocks.
 *
 * Returns the rewritten Markdown and the ground-truth map from block key to the
 * text it should now be found under (or null if it was deleted).
 */
function mutate(
  doc: ParsedDocument,
  rng: Rng,
  intensity: number,
): { markdown: string; truth: Map<string, string[]>; mutations: Mutation[] } {
  // Work at top level: nested blocks are re-emitted verbatim inside their
  // container, which is not what an agent rewriting prose produces.
  const blocks: LogicalBlock[] = doc.blocks
    .filter((b) => b.depth === 0)
    .map((b, i) => ({ key: `k${i}`, origin: `k${i}`, text: b.source, deleted: false }));

  const prose = (index: number): boolean => {
    const text = blocks[index]?.text ?? '';
    return !/^(```|~~~|\||#|>|---|\s*[-*+]\s|\s*\d+[.)]\s|\[)/.test(text) && text.length > 40;
  };

  const mutations: Mutation[] = [];
  const count = Math.max(1, Math.round(blocks.length * intensity));

  for (let n = 0; n < count; n++) {
    const live = blocks.map((b, i) => ({ b, i })).filter(({ b }) => !b.deleted);
    if (live.length < 3) break;
    const choice = rng.pick(live);
    const index = choice.i;

    const roll = rng.float();
    if (roll < 0.3 && prose(index)) {
      blocks[index]!.text = rewordLight(blocks[index]!.text, rng);
      mutations.push('reword-light');
    } else if (roll < 0.45 && prose(index)) {
      blocks[index]!.text = rewordHeavy(blocks[index]!.text, rng);
      mutations.push('reword-heavy');
    } else if (roll < 0.55 && prose(index)) {
      blocks[index]!.text = tighten(blocks[index]!.text);
      mutations.push('tighten');
    } else if (roll < 0.65 && prose(index)) {
      blocks[index]!.text = expand(blocks[index]!.text, rng);
      mutations.push('expand');
    } else if (roll < 0.72) {
      // Insert a brand-new block. It has no anchor, and must not steal one.
      blocks.splice(index, 0, {
        key: `new${n}`,
        origin: `new${n}`,
        text: rng.pick(FILLER),
        deleted: false,
      });
      mutations.push('insert');
    } else if (roll < 0.8) {
      // Delete removes *this fragment*. If the block had been split earlier,
      // its other fragments are still on the page and still legitimately the
      // original paragraph — so identity is only truly gone when every fragment
      // is, which the origin-based truth below works out on its own.
      blocks[index]!.deleted = true;
      mutations.push('delete');
    } else if (roll < 0.9) {
      const [moved] = blocks.splice(index, 1);
      const target = rng.int(blocks.length);
      blocks.splice(target, 0, moved!);
      mutations.push('reorder');
    } else if (prose(index)) {
      // Split one paragraph into two.
      //
      // Ground truth here is a *set*, not a value: after a split there is no
      // single correct target. Both halves are equally the original paragraph,
      // and a reviewer looking at a comment on the original would accept
      // either. Asserting one of them would be asserting a fact that is not
      // true of the domain — so both are accepted, and landing anywhere else
      // is still a misattachment. The set is derived from `origin`, so it stays
      // correct however many times the fragments are split or reworded after.
      const text = blocks[index]!.text;
      const at = Math.floor(text.length / 2);
      const boundary = text.indexOf(' ', at);
      if (boundary > 0) {
        blocks[index]!.text = text.slice(0, boundary);
        blocks.splice(index + 1, 0, {
          key: `split${n}`,
          origin: blocks[index]!.origin,
          text: text.slice(boundary + 1),
          deleted: false,
        });
        mutations.push('split');
      }
    }
  }

  const live = blocks.filter((b) => !b.deleted);
  const markdown = `${live.map((b) => b.text).join('\n\n')}\n`;

  // Acceptable targets per original block: the current text of every live block
  // descended from it. An empty list means "nothing of this block survives";
  // the only correct resolution is then an orphan.
  const truth = new Map<string, string[]>();
  for (const block of blocks) truth.set(block.origin, []);
  for (const block of blocks) {
    if (block.deleted) continue;
    truth.get(block.origin)!.push(block.text);
  }
  return { markdown, truth, mutations };
}

/** Anchors for a document's top-level blocks, keyed the same way `mutate` keys them. */
function topLevelAnchors(doc: ParsedDocument): Anchor[] {
  const out: Anchor[] = [];
  let key = 0;
  doc.blocks.forEach((block, index) => {
    if (block.depth !== 0) return;
    out.push({ id: `k${key++}`, fingerprint: fingerprintBlock(doc, index) });
  });
  return out;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

interface Tally {
  anchors: number;
  survived: number;
  orphaned: number;
  misattached: number;
  deletedCorrectlyOrphaned: number;
  deletedMisattached: number;
  examples: { was: string; expected: string; got: string; conf: number; runnerUp: number }[];
}

function runTrial(doc: ParsedDocument, rng: Rng, intensity: number, tally: Tally): void {
  const anchors = topLevelAnchors(doc);
  if (anchors.length < 4) return;
  const { markdown, truth } = mutate(doc, rng, intensity);
  const rewritten = parseDocument(markdown);
  const result = reanchor(anchors, rewritten);

  for (const anchor of anchors) {
    const expectedTexts = truth.get(anchor.id);
    if (expectedTexts === undefined) continue;
    const resolution = result.byAnchor.get(anchor.id)!;

    // Which blocks in the rewritten document would be a correct landing spot?
    const wanted = new Set(expectedTexts.map((t) => t.trim()));
    const acceptable: number[] = [];
    rewritten.blocks.forEach((b, i) => {
      if (b.depth === 0 && wanted.has(b.source.trim())) acceptable.push(i);
    });

    if (acceptable.length === 0) {
      // Nothing of *this* block survives as its own block — but its content may
      // still be on the page, in two ways the matcher cannot be blamed for:
      //
      //  - an identical block elsewhere, which is the ambiguity case tested
      //    directly in `reanchor.test.ts`;
      //  - **absorption**: deleting a paragraph between two lists makes them
      //    adjacent, and CommonMark merges them into one. The deleted list's
      //    items are now inside the survivor, so matching it is defensible
      //    rather than wrong.
      //
      // Both are excluded from the misattachment count and from the survival
      // rate; neither is quietly counted as a success.
      const wantedText = normalizeText(anchor.fingerprint.text).trim();
      const absorbed =
        wantedText.length > 0 &&
        rewritten.blocks.some((b) => {
          if (b.depth !== 0) return false;
          const candidate = normalizeText(b.text).trim();
          return candidate === wantedText || candidate.includes(wantedText);
        });
      if (absorbed) continue;

      // Orphaning is the only correct answer; pointing at any surviving block
      // is a misattachment.
      tally.anchors++;
      if (resolution.blockIndex === null) tally.deletedCorrectlyOrphaned++;
      else {
        tally.deletedMisattached++;
        if (tally.examples.length < 6) {
          tally.examples.push({
            was: `DELETED: ${anchor.fingerprint.text.slice(0, 90)}`,
            expected: '(orphan)',
            got: rewritten.blocks[resolution.blockIndex]!.text.slice(0, 120),
            conf: resolution.confidence,
            runnerUp: resolution.runnerUp,
          });
        }
      }
      continue;
    }

    // Genuinely identical blocks have no single right answer; excluding them is
    // not a fudge, it is the definition of the ambiguity case tested elsewhere.
    if (acceptable.length > expectedTexts.length) continue;

    tally.anchors++;
    if (resolution.blockIndex !== null && acceptable.includes(resolution.blockIndex)) {
      tally.survived++;
    } else if (resolution.blockIndex === null) {
      tally.orphaned++;
    } else {
      tally.misattached++;
      if (tally.examples.length < 6) {
        tally.examples.push({
          was: anchor.fingerprint.text.slice(0, 90),
          expected: expectedTexts.map((t) => t.trim().slice(0, 60)).join(' | '),
          got: rewritten.blocks[resolution.blockIndex]!.text.slice(0, 90),
          conf: resolution.confidence,
          runnerUp: resolution.runnerUp,
        });
      }
    }
  }
}

describe('anchor benchmark', () => {
  const seed = 0xa9c40;

  it('meets the gate: ≥95% survival, zero silent misattachments', () => {
    const rng = makeRng(seed);
    const tally: Tally = {
      anchors: 0,
      survived: 0,
      orphaned: 0,
      misattached: 0,
      deletedCorrectlyOrphaned: 0,
      deletedMisattached: 0,
      examples: [],
    };

    for (const { source } of DOCUMENTS) {
      const doc = parseDocument(source);
      for (let trial = 0; trial < 40; trial++) {
        // Intensity sweeps from a light touch-up to a heavy section rewrite.
        runTrial(doc, rng, 0.05 + (trial / 40) * 0.45, tally);
      }
    }

    const survivable = tally.survived + tally.orphaned + tally.misattached;
    const survival = tally.survived / survivable;
    const misattachments = tally.misattached + tally.deletedMisattached;

    // Printed, not asserted on beyond the gate: the numbers are how you tell
    // whether a threshold change helped or just moved failures around.
    console.log(
      `anchor benchmark (seed 0x${seed.toString(16)}): ` +
        `${survivable} anchors, survival ${(survival * 100).toFixed(2)}%, ` +
        `orphans ${tally.orphaned}, misattached ${tally.misattached}, ` +
        `deleted-blocks ${tally.deletedCorrectlyOrphaned + tally.deletedMisattached} ` +
        `(orphaned ${tally.deletedCorrectlyOrphaned}, misattached ${tally.deletedMisattached})`,
    );

    if (tally.examples.length > 0) console.log(JSON.stringify(tally.examples, null, 1));
    expect(survivable, 'benchmark did not exercise enough anchors to be meaningful').toBeGreaterThan(
      400,
    );
    expect(misattachments, `misattachments must be zero; seed 0x${seed.toString(16)}`).toBe(0);
    expect(survival, `survival below the 95% gate; seed 0x${seed.toString(16)}`).toBeGreaterThanOrEqual(
      0.95,
    );
  });

  it('survives at 100% when the edit arrives through Galley, because identity is in the payload', () => {
    // The contrast that justifies the whole block-op design: the same heavy
    // rewrites, but with markers intact, need no inference at all.
    const rng = makeRng(seed);
    let written = 0;
    let preserved = 0;
    let resolvedByMarker = 0;

    for (const { source } of DOCUMENTS) {
      const doc = parseDocument(source);
      const anchors = topLevelAnchors(doc);
      if (anchors.length < 4) continue;

      const blocks = doc.blocks.filter((b) => b.depth === 0);
      const rewrittenBlocks = blocks.map((block, i) => {
        if (block.type !== 'paragraph') return block.source;
        written++;
        return `${rewordHeavy(block.source, rng)} <!-- ^k${i} -->`;
      });
      const rewritten = parseDocument(`${rewrittenBlocks.join('\n\n')}\n`);
      const result = reanchor(anchors, rewritten);

      // A marker that is still in the document must resolve by marker — never
      // by inference, and never to a different block.
      for (const block of rewritten.blocks) {
        if (!block.id) continue;
        preserved++;
        const resolution = result.byAnchor.get(block.id);
        expect(resolution?.method, `id ${block.id} did not resolve by its marker`).toBe('marker');
        expect(resolution?.blockIndex).toBe(rewritten.blocks.indexOf(block));
        resolvedByMarker++;
      }
    }

    expect(written).toBeGreaterThan(50);
    expect(resolvedByMarker).toBe(preserved);
    // The simulator's rewriter is deliberately crude and can mangle a paragraph
    // into something that no longer parses as one, taking its inline marker with
    // it. That is an artefact of the generator, not of the mechanism, so the bar
    // here is "almost all", with the exact claim — every surviving marker
    // resolves by marker — asserted above.
    expect(preserved / written).toBeGreaterThan(0.95);
  });
});
