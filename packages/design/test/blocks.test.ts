/**
 * Claims under test (`src/blocks.ts`):
 *
 *  1. Every block in the palette is *valid on arrival* — it inserts cleanly,
 *     serializes, parses back, and lints without a finding. A palette entry
 *     that produces a design the linter complains about hands the person least
 *     equipped to fix it a problem they did not make.
 *  2. Every block is *visible on arrival*. The failure this catalog exists to
 *     prevent is an "add" that appears to do nothing, which is what a box with
 *     no layout classes is.
 *  3. Ids are unique, because they are how an agent names one.
 */
import { describe, expect, it } from 'vitest';
import {
  BLOCKS,
  applyOps,
  blockById,
  lintDesign,
  parseDesign,
  resolveClasses,
  serializeDesign,
  walk,
  type DesignDocument,
} from '../src/index.js';

const EMPTY = [
  '<design name="Test">',
  '  <frame name="Screen" width="390" class="flex flex-col gap-4 p-6 bg-canvas">',
  '  </frame>',
  '</design>',
].join('\n');

function emptyDesign(): DesignDocument {
  const parsed = parseDesign(EMPTY);
  if (!parsed.ok) throw new Error(parsed.errors.map((e) => e.message).join('; '));
  return parsed.design;
}

/** Insert one block into a bare frame and return the design it produced. */
function withBlock(id: string): DesignDocument {
  const design = emptyDesign();
  const block = blockById(id);
  if (!block) throw new Error(`no block ${id}`);
  const frame = design.frames[0]!;
  const result = applyOps(design, [
    { op: 'insert', parent: frame.id, index: 0, layer: block.layer },
  ]);
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.design;
}

describe('the block palette', () => {
  it('names every block once', () => {
    const ids = BLOCKS.map((block) => block.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(BLOCKS.map((block) => [block.id, block.label] as const))(
    'inserts %s cleanly and survives a round trip',
    (id) => {
      const grown = withBlock(id);
      const text = serializeDesign(grown);
      const reparsed = parseDesign(text);
      expect(reparsed.ok, `${id}: ${reparsed.ok ? '' : reparsed.errors.map((e) => e.message).join('; ')}`).toBe(true);
      // Serializing the re-parsed design must give the same bytes, or an edit
      // through the canvas would rewrite parts of the file nobody touched.
      if (reparsed.ok) expect(serializeDesign(reparsed.design)).toBe(text);
    },
  );

  it.each(BLOCKS.map((block) => [block.id] as const))('uses only classes the format has: %s', (id) => {
    const grown = withBlock(id);
    const bad: string[] = [];
    for (const { layer } of walk(grown)) {
      if (!('classes' in layer)) continue;
      for (const problem of resolveClasses(layer.classes).problems) {
        bad.push(`${layer.name}: ${problem}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it.each(BLOCKS.map((block) => [block.id] as const))('lints clean: %s', (id) => {
    expect(lintDesign(withBlock(id))).toEqual([]);
  });

  it.each(BLOCKS.map((block) => [block.id] as const))('arrives visible: %s', (id) => {
    const block = blockById(id)!;
    const { layer } = block;
    if (layer.kind === 'text') {
      expect(layer.content?.trim()).toBeTruthy();
      return;
    }
    // A box is visible if it lays its children out or has a size of its own.
    // Neither and it is a zero-height rectangle nobody can click.
    const classes = layer.classes ?? [];
    const laysOut = classes.includes('flex');
    const hasSize = classes.some((name) => /^(h|w)-/.test(name));
    expect(laysOut || hasSize, `${id} would insert as an invisible box`).toBe(true);
  });
});
