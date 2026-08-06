/**
 * What a design promises.
 *
 * Four claims, one per describe block, and each is a way the format could be
 * worthless rather than merely imperfect:
 *
 *  1. **It round-trips.** A design opened and saved untouched is byte-identical,
 *     and an edited layer changes its own line and no other. This is the same
 *     gate the prose engine is held to, for the same reason: a tool whose
 *     `git diff` shows noise nobody created has lost its credibility for good.
 *  2. **It refuses rather than guesses.** An unknown element, an unclosed tag,
 *     a value outside the scale — each is an error naming a line and a fix, not
 *     a silent drop. A format that quietly ignores what it does not understand
 *     renders differently in the editor and in the export.
 *  3. **The vocabulary is closed.** There is no syntax for a literal colour, so
 *     the characteristic failure of a machine-written design — a blue that is
 *     almost the brand blue — cannot be expressed.
 *  4. **It is embeddable without extending Markdown.** A design is a document
 *     whose body is a fenced block; splicing it back leaves every other byte
 *     alone.
 */
import { describe, expect, it } from 'vitest';
import {
  STARTERS,
  embedDesign,
  extractDesign,
  find,
  lintDesign,
  outline,
  parseDesign,
  resolveClass,
  serializeDesign,
  walk,
  type DesignDocument,
  type Layer,
} from '../src/index.js';

function parsed(source: string): DesignDocument {
  const result = parseDesign(source);
  if (!result.ok) throw new Error(`expected a parse, got: ${result.errors.map((e) => e.message).join('; ')}`);
  return result.design;
}

/** Every id in a design, so a round-trip keeps the ones it was given. */
function idsOf(design: DesignDocument): Set<string> {
  return new Set([...walk(design)].map(({ layer }) => layer.id));
}

describe('round trip', () => {
  it.each(STARTERS.map((starter) => [starter.label, starter] as const))(
    '%s survives a load and save unchanged',
    (_label, starter) => {
      const design = parsed(starter.source);
      // Every id is durable here, because the starters carry none — the point
      // of the check is the markup, not the id policy, which has its own test.
      expect(serializeDesign(design, { durable: new Set() }).trim()).toBe(starter.source.trim());
    },
  );

  it('changes only the layer that was edited', () => {
    const source = STARTERS.find((s) => s.id === 'form')!.source;
    const design = parsed(source);

    // Rename the button's label, the way clicking it and typing would.
    const next = mapLayers(design, (layer) =>
      layer.kind === 'text' && layer.content === 'Pay $42.00' ? { ...layer, content: 'Pay $64.00' } : layer,
    );

    const before = source.trim().split('\n');
    const after = serializeDesign(next, { durable: new Set() }).trim().split('\n');
    expect(after.length).toBe(before.length);
    const changed = before.map((line, i) => (line === after[i] ? null : i)).filter((i) => i !== null);
    expect(changed).toHaveLength(1);
    expect(after[changed[0]!]).toContain('Pay $64.00');
  });

  it('materializes an id only when something is anchored to it', () => {
    const design = parsed(STARTERS.find((s) => s.id === 'card')!.source);
    expect(serializeDesign(design, { durable: new Set() })).not.toContain('id=');

    const anchored = [...idsOf(design)][2]!;
    const withId = serializeDesign(design, { durable: new Set([anchored]) });
    expect(withId).toContain(`id="${anchored}"`);
    // Exactly one, so a comment cannot silently attach to two layers.
    expect(withId.match(/id="/g)).toHaveLength(1);
    // And the id survives being read back, which is the whole point of writing it.
    expect(idsOf(parsed(withId))).toContain(anchored);
  });
});

describe('refusing rather than guessing', () => {
  it('names an unknown element and says what the elements are', () => {
    const result = parseDesign('<design name="x"><frame width="100"><div></div></frame></design>');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.message).toContain('`<div>`');
    expect(result.errors[0]!.message).toContain('`<box>`');
  });

  it('reports an unclosed tag against the line it was opened on', () => {
    const result = parseDesign(['<design name="x">', '  <frame width="100">', '    <box>', '  </frame>', '</design>'].join('\n'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.message.includes('opened on line 3'))).toBe(true);
  });

  it('refuses loose text outside a text element', () => {
    const result = parseDesign('<design name="x"><frame width="100">hello</frame></design>');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.message).toContain('`<text>`');
  });

  it('refuses a frame with no width', () => {
    const result = parseDesign('<design name="x"><frame></frame></design>');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.message).toContain('width');
  });
});

describe('the closed vocabulary', () => {
  it('has no syntax for a literal colour', () => {
    const literal = resolveClass('bg-[#2463eb]');
    expect(literal.ok).toBe(false);
    const hue = resolveClass('bg-blue-500');
    expect(hue.ok).toBe(false);
    if (hue.ok) return;
    // The message has to carry the fix, or the next attempt is another guess.
    expect(hue.message).toContain('role');
    expect(hue.message).toMatch(/bg-[a-z-]+/);
  });

  it('resolves a role colour to a themeable variable, not a hex', () => {
    const resolved = resolveClass('bg-accent');
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.css['background-color']).toMatch(/^var\(--d-/);
  });

  it('pins a leading with every type size', () => {
    const resolved = resolveClass('text-h2');
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.css['font-size']).toBeTruthy();
    expect(resolved.css['line-height']).toBeTruthy();
  });

  it('rejects a spacing value off the scale and names one on it', () => {
    const resolved = resolveClass('gap-7');
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.message).toContain('gap-');
  });
});

describe('the linter catches what a model gets wrong', () => {
  it('passes every starter', () => {
    for (const starter of STARTERS) {
      expect(lintDesign(parsed(starter.source)), starter.label).toEqual([]);
    }
  });

  it('flags an image with no description', () => {
    const design = parsed('<design name="x"><frame width="100"><image src="a.png" alt="" /></frame></design>');
    const findings = lintDesign(design);
    expect(findings.some((f) => f.severity === 'error' && f.message.includes('description'))).toBe(true);
  });

  it('flags alignment classes on something that is not a row or a column', () => {
    const design = parsed('<design name="x"><frame width="100"><box class="justify-between gap-4"></box></frame></design>');
    const findings = lintDesign(design);
    expect(findings.some((f) => f.message.includes('does nothing here'))).toBe(true);
  });

  it('flags two layers claiming one id', () => {
    const design = parsed(
      '<design name="x"><frame width="100"><box id="l_a"></box><box id="l_a"></box></frame></design>',
    );
    expect(lintDesign(design).some((f) => f.message.includes('names 2 layers'))).toBe(true);
  });

  it('outlines a design far more cheaply than the design itself', () => {
    const starter = STARTERS.find((s) => s.id === 'form')!;
    const sparse = outline(parsed(starter.source));
    expect(sparse.length).toBeLessThan(starter.source.length);
    expect(sparse).toContain('Pay button');
    // Structure without styling: no class list survives into the outline.
    expect(sparse).not.toContain('rounded-md');
  });
});

describe('living in a document', () => {
  const document = ['---', 'galley: 01ABC', '---', '', '# Payment screen', '', '```design', '<design name="x">', '  <frame width="100"></frame>', '</design>', '```', '', 'Notes below.', ''].join('\n');

  it('finds the design in a document that also has prose', () => {
    const found = extractDesign(document);
    expect(found).not.toBeNull();
    expect(found!.design.frames).toHaveLength(1);
  });

  it('is not fooled by a document with no design', () => {
    expect(extractDesign('# Just prose\n\nWith a ```js fence\n```js\nconst x = 1;\n```\n')).toBeNull();
  });

  it('splices the design back and leaves every other byte alone', () => {
    const next = embedDesign(document, '<design name="y">\n  <frame width="200"></frame>\n</design>');
    expect(next).toContain('galley: 01ABC');
    expect(next).toContain('# Payment screen');
    expect(next).toContain('Notes below.');
    expect(next).toContain('width="200"');
    expect(next).not.toContain('width="100"');
    // Everything before and after the fence is character-for-character intact.
    expect(next.slice(0, next.indexOf('```design'))).toBe(document.slice(0, document.indexOf('```design')));
    expect(next.slice(next.lastIndexOf('```') + 3)).toBe(document.slice(document.lastIndexOf('```') + 3));
  });

  it('round-trips a design document through extract and embed unchanged', () => {
    const found = extractDesign(document)!;
    expect(embedDesign(document, found.source)).toBe(document);
  });

  it('finds a layer by id, which is how a citation resolves', () => {
    const design = parsed('<design name="x"><frame width="100"><box id="l_pay" name="Pay"></box></frame></design>');
    const layer = find(design, 'l_pay');
    expect(layer).not.toBeNull();
    expect(layer!.name).toBe('Pay');
  });
});

/** Rewrite every layer in a design, the way an editor transaction would. */
function mapLayers(design: DesignDocument, fn: (layer: Layer) => Layer): DesignDocument {
  const descend = (layer: Layer): Layer => {
    const mapped = fn(layer);
    if (mapped.kind !== 'box') return mapped;
    return { ...mapped, children: mapped.children.map(descend) };
  };
  return { ...design, frames: design.frames.map((frame) => ({ ...frame, children: frame.children.map(descend) })) };
}
