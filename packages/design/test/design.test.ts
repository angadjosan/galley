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

/**
 * The ways the parser used to accept something and quietly change it.
 *
 * Every case here was found by adversarial review, and every one returned
 * `ok: true` with no errors while losing or corrupting content. That is the
 * single outcome this format exists to make impossible — a design that renders
 * differently from what its author wrote, with nothing to point at.
 *
 * The lesson for the next reader: the original test suite passed all 24 of its
 * assertions against inputs written to satisfy it. Attacking the format is a
 * different activity from covering it.
 */
describe('nothing is accepted and quietly changed', () => {
  /** Parse, expecting failure, and return the messages. */
  function errors(source: string): string[] {
    const result = parseDesign(source);
    if (result.ok) throw new Error('expected this to be refused, but it parsed');
    return result.errors.map((error) => error.message);
  }

  const wrap = (inner: string): string => `<design name="x">\n<frame width="100">\n${inner}\n</frame>\n</design>`;

  it('refuses an unquoted attribute rather than dropping the styling', () => {
    expect(errors(wrap('<box class=flex></box>')).join(' ')).toContain('class="flex"');
  });

  it('refuses an attribute given twice rather than picking one', () => {
    expect(errors(wrap('<box class="flex" class="p-4"></box>')).join(' ')).toContain('twice');
  });

  it('refuses something that is not an attribute at all', () => {
    expect(errors(wrap('<box "flex"></box>')).length).toBeGreaterThan(0);
  });

  it('reads an attribute containing a closing angle bracket correctly', () => {
    // This used to end the tag inside the quotes: the name was destroyed and
    // the leftover became the element's content, with `ok: true`.
    const design = parsed(wrap('<text name="a&gt;b">hi</text>'));
    const text = design.frames[0]!.children[0]!;
    expect(text.name).toBe('a>b');
    expect(text.kind === 'text' && text.content).toBe('hi');
  });

  it('does not throw on a code point outside Unicode', () => {
    // This ran inside a React render and inside a ProseMirror decorations()
    // call, so one of these took down the canvas *and* every prose document
    // that linked to the design.
    expect(() => parseDesign(wrap('<text>&#1114112;</text>'))).not.toThrow();
    expect(errors(wrap('<text>&#1114112;</text>')).join(' ')).toContain('not a character');
  });

  it('decodes a hex entity rather than silently leaving it as text', () => {
    // Unhandled, it survived as literal text and was then escaped into
    // `&amp;#x27;` on the way out — a round trip that changed the label.
    const design = parsed(wrap('<text>&#x27;q&#x27;</text>'));
    const text = design.frames[0]!.children[0]!;
    expect(text.kind === 'text' && text.content).toBe("'q'");
  });

  it('refuses a frame inside a frame rather than hoisting it', () => {
    // Hoisting emitted the inner frame *first*, so frames reordered on save.
    expect(errors('<design name="x"><frame width="100"><frame width="50"></frame></frame></design>').join(' ')).toContain(
      'cannot go inside',
    );
  });

  it('refuses a design inside a design', () => {
    expect(errors('<design name="a"><design name="b"></design></design>').join(' ')).toContain('another');
  });

  it('refuses a layer inside a text rather than dropping both', () => {
    expect(errors(wrap('<text>hi<box></box></text>')).join(' ')).toContain('holds words');
  });

  it('refuses a height that is not a number', () => {
    // It became NaN, was written back as `height="NaN"`, and reached the
    // renderer as a style nobody could see was wrong.
    expect(errors('<design name="x"><frame width="100" height="tall"></frame></design>').join(' ')).toContain('height');
  });

  it('accepts a written-out image close tag without inventing four errors', () => {
    const result = parseDesign(wrap('<image src="a.png" alt="A picture"></image>'));
    expect(result.ok).toBe(true);
  });
});

describe('a design is only a design when the fence says exactly that', () => {
  const body = '<design name="x">\n  <frame width="10"></frame>\n</design>';

  it.each([
    ['a designer fence', 'designer'],
    ['a designsystem fence', 'designsystem'],
    ['an info string with a tail', 'design foo'],
  ])('does not open %s as a design', (_name, info) => {
    // A prefix match made an ordinary prose document unreachable in the prose
    // editor, and the next save rewrote its info string to `design`.
    expect(extractDesign(`# a\n\n\`\`\`${info}\nnot a design\n\`\`\`\n`)).toBeNull();
  });

  it('opens an exact design fence', () => {
    expect(extractDesign(`# a\n\n\`\`\`design\n${body}\n\`\`\`\n`)).not.toBeNull();
  });

  it.each([
    ['the fence alone', `\`\`\`design\n${body}\n\`\`\`\n`],
    ['prose either side', `# t\n\n\`\`\`design\n${body}\n\`\`\`\n\nafter\n`],
    ['another fence first', `\`\`\`js\nx\n\`\`\`\n\n\`\`\`design\n${body}\n\`\`\`\n`],
    ['a tilde fence', `~~~design\n${body}\n~~~\n`],
    ['no trailing newline', `\`\`\`design\n${body}\n\`\`\``],
  ])('puts %s back exactly as it was', (_name, document) => {
    const found = extractDesign(document);
    expect(found).not.toBeNull();
    expect(embedDesign(document, found!.source)).toBe(document);
  });
});

/**
 * Ids have to be a function of position, not of a counter.
 *
 * The canvas re-parses on every edit and holds the selected layer's id. A
 * monotonic counter is stable within one parse and useless across two, so the
 * selection died on every keystroke — and two parses of the same bytes
 * disagreed about what a layer was called, which is not a property an
 * identifier may have.
 */
describe('provisional ids', () => {
  it('gives the same layer the same id every time it is read', () => {
    const source = STARTERS.find((starter) => starter.id === 'form')!.source;
    expect([...idsOf(parsed(source))]).toEqual([...idsOf(parsed(source))]);
  });

  it('gives every layer in a design a different id', () => {
    for (const starter of STARTERS) {
      const design = parsed(starter.source);
      const ids = [...walk(design)].map(({ layer }) => layer.id);
      expect(new Set(ids).size, starter.label).toBe(ids.length);
    }
  });

  it('survives an edit to another layer', () => {
    const source = STARTERS.find((starter) => starter.id === 'cards')?.source ?? STARTERS[2]!.source;
    const before = parsed(source);
    const target = [...walk(before)][3]!.layer.id;
    const edited = serializeDesign(
      {
        ...before,
        frames: before.frames.map((frame) => ({
          ...frame,
          children: frame.children.map((child) =>
            child.kind === 'text' ? { ...child, content: 'Changed' } : child,
          ),
        })),
      },
      { durable: new Set() },
    );
    expect([...idsOf(parsed(edited))]).toContain(target);
  });
});
