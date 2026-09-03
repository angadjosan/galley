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
  applyOps,
  embedDesign,
  extractDesign,
  find,
  idAfter,
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
    // The parser refuses this outright now, so the design is built by hand —
    // the linter rule still has to hold for a tree that reached it another way,
    // and it is the layer that catches a collision the parser cannot see.
    const design: DesignDocument = {
      name: 'x',
      frames: [
        {
          id: 'f',
          name: 'Frame 1',
          width: 100,
          height: 'auto',
          classes: [],
          children: [
            { id: 'l_a', kind: 'box', name: 'Box', classes: [], children: [] },
            { id: 'l_a', kind: 'box', name: 'Box', classes: [], children: [] },
          ],
        },
      ],
    };
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

/**
 * An error message is only useful if it carries a fix that is actually the fix.
 *
 * The suggestion machinery used to fall back to "the first key in the object",
 * which produced `gap-7 → try gap-0` — the single worst answer available — and
 * answered `text-justify` with a sentence about the colour palette. A wrong
 * suggestion is worse than none, because the next attempt is another guess.
 */
describe('what an error says to do next', () => {
  function messageFor(name: string): string {
    const resolved = resolveClass(name);
    if (resolved.ok) throw new Error(`expected \`${name}\` to be refused`);
    return resolved.message;
  }

  it('suggests the nearest spacing step, not the first one', () => {
    expect(messageFor('gap-7')).toContain('gap-6');
    expect(messageFor('gap-9')).toContain('gap-8');
    expect(messageFor('p-100')).toContain('p-24');
  });

  it('answers an alignment mistake with alignments', () => {
    const message = messageFor('text-justify');
    expect(message).toContain('text-left');
    expect(message).not.toContain('palette');
  });

  it('shows the palette when there is no near colour to name', () => {
    const message = messageFor('bg-chartreuse');
    expect(message).toContain('role');
    expect(message).toContain('galley design classes');
  });

  it.each([
    ['a border thicker than a border gets', 'border-999'],
    ['an opacity above opaque', 'opacity-999'],
    ['a size larger than any frame', 'w-99999'],
  ])('bounds %s', (_name, className) => {
    // Each of these resolved silently before — numeric escapes that had slipped
    // past the "no literals" rule with nobody arguing for them.
    expect(resolveClass(className).ok).toBe(false);
  });

  it('still accepts the values inside those bounds', () => {
    for (const className of ['border-2', 'opacity-60', 'w-320', 'h-44']) {
      expect(resolveClass(className).ok, className).toBe(true);
    }
  });
});

/**
 * A second round found these, after the first round's fixes were in.
 *
 * The pattern is worth naming: every one is a case where the *guard* was right
 * and its *assumption* was not. `pathOf` skipped index 0 assuming it was the
 * `<design>` wrapper; the nesting refusal checked for a design inside a design
 * but not one beside it; the "words belong in a `<text>`" error only fired when
 * there was something to be inside of.
 */
describe('what the second round found', () => {
  function errorsOf(source: string): string[] {
    const result = parseDesign(source);
    return result.ok ? [] : result.errors.map((error) => error.message);
  }

  it('gives every layer a different id even with no design wrapper', () => {
    // `pathOf` skipped the first stack entry assuming it was `<design>`. With
    // no wrapper the frame and its first child both came out as `l_0` — a
    // collision in an identifier, and the canvas keys React on it and matches
    // edits by it, so selecting or deleting one hit both.
    const design = parsed('<frame width="10"><box></box><box></box></frame>');
    const ids = [...walk(design)].map(({ layer }) => layer.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('refuses two layers that claim the same id', () => {
    expect(
      errorsOf('<design name="x"><frame width="10"><box id="l_a"></box><box id="l_a"></box></frame></design>').join(' '),
    ).toContain('more than one layer');
  });

  it('refuses a second design beside the first rather than merging them', () => {
    // Accepted, they became one design named after the *second*, carrying both
    // sets of frames — and the next save rewrote the file that way.
    expect(errorsOf('<design name="A"><frame width="10"></frame></design><design name="B"><frame width="20"></frame></design>').join(' ')).toContain(
      'one `<design>`',
    );
  });

  it('refuses words outside the design rather than dropping them', () => {
    expect(errorsOf('hello<design name="x"><frame width="10"></frame></design>').join(' ')).toContain('outside');
  });

  it.each([
    ['a hex width', '<design name="x"><frame width="0x10"></frame></design>'],
    ['an exponent width', '<design name="x"><frame width="1e3"></frame></design>'],
    ['a padded width', '<design name="x"><frame width=" 10 "></frame></design>'],
  ])('refuses %s rather than coercing it', (_name, source) => {
    // `Number()` swallowed all three, and the file was then rewritten with the
    // coerced value — a save that silently changed a number nobody touched.
    expect(errorsOf(source).length).toBeGreaterThan(0);
  });

  it('treats an attribute named after an Object member as an ordinary name', () => {
    // `key in attrs` on a bare literal found `constructor` on the prototype and
    // reported it as given twice when it appeared once.
    expect(errorsOf('<design name="x"><frame width="10"><box constructor="y"></box></frame></design>')).toEqual([]);
  });
});

/**
 * The op vocabulary.
 *
 * The claim it exists to make: **the canvas and the agent speak the same
 * language.** A mouse drag and an agent's proposal produce the same kind of
 * thing, so undo, history, attribution and review are one implementation.
 *
 * The property that makes a *batch* usable is the one tested hardest here.
 * Layer ids are derived from position, so an insert renumbers everything after
 * it — and a batch that resolved its targets one at a time would have op 2
 * addressing a layer op 1 moved out from under it.
 */
describe('design ops', () => {
  const source = [
    '<design name="x">',
    '  <frame width="100">',
    '    <box name="First"></box>',
    '    <box name="Second"></box>',
    '    <text name="Label">hi</text>',
    '  </frame>',
    '</design>',
  ].join('\n');

  function applied(ops: Parameters<typeof applyOps>[1]): DesignDocument {
    const result = applyOps(parsed(source), ops);
    if (!result.ok) throw new Error(`expected the batch to apply: ${result.errors.join('; ')}`);
    return result.design;
  }

  function namesIn(design: DesignDocument): string[] {
    return design.frames[0]!.children.map((child) => child.name);
  }

  it('resolves every target against the tree as it was, not as it becomes', () => {
    // `l_0_0` and `l_0_2` are First and Label. Inserting at the front renumbers
    // both — so a batch that resolved lazily would rename the wrong layers.
    const design = applied([
      { op: 'insert', parent: 'l_0', index: 0, layer: { kind: 'box', name: 'Inserted' } },
      { op: 'set-name', id: 'l_0_0', name: 'First renamed' },
      { op: 'set-name', id: 'l_0_2', name: 'Label renamed' },
    ]);
    expect(namesIn(design)).toEqual(['Inserted', 'First renamed', 'Second', 'Label renamed']);
  });

  it('applies all of a batch or none of it', () => {
    // Half a batch is a design nobody asked for and nobody can review.
    const result = applyOps(parsed(source), [
      { op: 'set-name', id: 'l_0_0', name: 'Changed' },
      { op: 'set-name', id: 'l_nope', name: 'Never' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toContain('l_nope');
  });

  it('moves a layer into another and keeps its subtree', () => {
    const design = applied([{ op: 'move', id: 'l_0_2', parent: 'l_0_0', index: 0 }]);
    expect(namesIn(design)).toEqual(['First', 'Second']);
    const first = design.frames[0]!.children[0]!;
    expect(first.kind === 'box' && first.children.map((c) => c.name)).toEqual(['Label']);
  });

  it('refuses to move a layer inside itself', () => {
    // Allowing it detaches the whole subtree from the document and loses it.
    const result = applyOps(parsed(source), [{ op: 'move', id: 'l_0_0', parent: 'l_0_0', index: 0 }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toContain('inside itself');
  });

  it('refuses to delete the only frame', () => {
    const result = applyOps(parsed(source), [{ op: 'delete', id: 'l_0' }]);
    expect(result.ok).toBe(false);
  });

  it('produces a design that still serializes and lints', () => {
    const design = applied([
      { op: 'insert', parent: 'l_0', index: 1, layer: { kind: 'text', name: 'New', classes: ['text-body', 'text-fg'], content: 'Added' } },
      { op: 'set-classes', id: 'l_0_0', classes: ['flex', 'flex-col', 'gap-2'] },
    ]);
    const markup = serializeDesign(design, { durable: new Set() });
    expect(markup).toContain('Added');
    // The output is real: it parses, and it has nothing for the linter to say.
    expect(lintDesign(parsed(markup))).toEqual([]);
  });

  it('says where a layer will be before the next read', () => {
    // Positional ids mean the editor cannot know what it just created without
    // this, and re-deriving it by hand in the editor would be a second copy of
    // the rule.
    const design = parsed(source);
    expect(idAfter(design, 'l_0', 1)).toBe('l_0_1');
    expect(idAfter(design, 'l_0_0', 0)).toBe('l_0_0_0');
    expect(idAfter(design, 'l_missing', 0)).toBeNull();
  });
});

/**
 * Text nobody can read.
 *
 * The rule nothing else in the field runs *in the loop*: accessibility tooling
 * overwhelmingly checks a rendered page long after the model that chose the
 * colours has stopped. Here it is a fact about the markup, because the palette
 * and the type scale are both closed — so the ratio is computable without
 * rendering anything, in every mode at once.
 *
 * It earned itself immediately: on its first run it found placeholder text in
 * the Form starter at 2.92:1, which is exactly the accessibility defect
 * placeholders are famous for.
 */
describe('contrast', () => {
  const frame = (inner: string, frameClasses = 'bg-canvas'): string =>
    `<design name="x">\n<frame width="200" class="${frameClasses}">\n${inner}\n</frame>\n</design>`;

  function messages(source: string): string[] {
    return lintDesign(parsed(source)).map((finding) => finding.message);
  }

  it('finds the background by walking up, not by looking at the text', () => {
    // A label almost never names its own background. Without the walk this rule
    // would be silent on every real design.
    const found = messages(
      frame('<box class="flex flex-col bg-accent">\n<text class="text-body text-fg-subtle">Hard to read</text>\n</box>'),
    );
    expect(found.join(' ')).toContain('`bg-accent`');
  });

  it('sees through a container that paints nothing', () => {
    const found = messages(
      frame('<box class="flex flex-col">\n<text class="text-body text-on-accent">Invisible</text>\n</box>', 'bg-canvas'),
    );
    // White ink on the canvas, through a transparent box.
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]).toContain('`bg-canvas`');
  });

  it('holds large text to the lower bar the standard sets', () => {
    // WCAG 2.2 §1.4.3: 3:1 at ≥24px. `text-display` is 40px, `text-body` 15px,
    // and the same ink has to pass one and fail the other for the rule to be
    // doing anything.
    const ink = 'text-fg-subtle';
    const big = messages(frame(`<text class="text-display ${ink}">Big</text>`, 'bg-accent-soft'));
    const small = messages(frame(`<text class="text-body ${ink}">Small</text>`, 'bg-accent-soft'));
    expect(small.length).toBeGreaterThan(big.length);
  });

  it('names the ratio, the pair, the size and the target', () => {
    // A finding that does not carry all four is not actionable: the reader
    // cannot tell how far off it is or what to change.
    const [message] = messages(frame('<text class="text-body text-fg-subtle">Faint</text>', 'bg-accent-soft'));
    expect(message).toMatch(/\d+\.\d+:1/);
    expect(message).toContain('text-fg-subtle');
    expect(message).toContain('bg-accent-soft');
    expect(message).toMatch(/\d+px/);
    expect(message).toContain('4.5:1');
  });

  it('checks every mode, so a design cannot be legible in one and not the other', () => {
    const found = messages(frame('<text class="text-body text-fg-subtle">Faint</text>', 'bg-accent-soft'));
    const modes = new Set(found.map((message) => (message.includes('in light') ? 'light' : 'dark')));
    expect(modes.size).toBeGreaterThan(0);
  });

  it('says nothing about empty text', () => {
    expect(messages(frame('<text class="text-body text-fg-subtle"></text>')).filter((m) => m.includes(':1'))).toEqual([]);
  });

  it('leaves an unknown role to the rule that owns it', () => {
    // Reporting the same mistake twice, in two voices, helps nobody.
    const found = messages(frame('<text class="text-body text-nonsense">Hi</text>'));
    expect(found.filter((message) => message.includes(':1'))).toEqual([]);
  });
});

/**
 * The hazard that a drag creates, and the reason it has to be fixed before
 * there is a drag.
 *
 * Layer ids are derived from position, and something *anchored* — a comment, a
 * citation — keeps its id written into the file so the anchor can find it
 * again. Move a layer and those two facts collide: the anchored layer keeps
 * `l_0_2` while a different layer inherits position 2 and derives the same
 * string. Before this fix that produced a design which **would not parse at
 * all** — one drag on a design with one comment on it destroyed the file.
 *
 * The fix is small and general: a derived id is chosen *around* the ids the
 * file states outright, never into them. Determinism survives, because the set
 * of stated ids is a property of the bytes.
 */
describe('an anchor survives the layer being moved', () => {
  const source = [
    '<design name="x">',
    '  <frame width="100">',
    '    <box name="A"></box>',
    '    <box name="B"></box>',
    '    <box name="C"></box>',
    '  </frame>',
    '</design>',
  ].join('\n');

  /** Move the first child to the end, keeping `anchored` durable. */
  function shuffle(design: DesignDocument, anchored: ReadonlySet<string>): DesignDocument {
    const first = design.frames[0]!.children[0]!.id;
    const moved = applyOps(design, [{ op: 'move', id: first, parent: design.frames[0]!.id, index: 3 }]);
    if (!moved.ok) throw new Error(moved.errors.join('; '));
    const markup = serializeDesign(moved.design, { durable: anchored });
    const back = parseDesign(markup);
    if (!back.ok) throw new Error(`the design stopped parsing: ${back.errors.map((e) => e.message).join('; ')}`);
    return back.design;
  }

  it('keeps pointing at the same layer across repeated moves', () => {
    const anchored = new Set(['l_0_2']);
    let design = parsed(source);
    // Three rounds, because the collision only appears once a *different*
    // layer has inherited the anchored one's old position.
    for (let round = 0; round < 3; round++) {
      design = shuffle(design, anchored);
      const anchoredLayer = design.frames[0]!.children.find((child) => child.id === 'l_0_2');
      expect(anchoredLayer?.name, `round ${round}`).toBe('C');
    }
  });

  it('never derives an id the file has already claimed', () => {
    const design = shuffle(parsed(source), new Set(['l_0_2']));
    const ids = [...walk(design)].map(({ layer }) => layer.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is deterministic: the same bytes give the same ids', () => {
    const markup = serializeDesign(shuffle(parsed(source), new Set(['l_0_2'])), { durable: new Set(['l_0_2']) });
    const once = [...walk(parsed(markup))].map(({ layer }) => layer.id);
    const twice = [...walk(parsed(markup))].map(({ layer }) => layer.id);
    expect(once).toEqual(twice);
  });
});

describe('renaming a design', () => {
  const SOURCE = [
    '<design name="Untitled design">',
    '  <frame name="Screen" width="390" class="flex flex-col gap-4 p-6 bg-canvas">',
    '    <text class="text-h2 text-fg">Title</text>',
    '  </frame>',
    '</design>',
  ].join('\n');

  function parsed() {
    const result = parseDesign(SOURCE);
    if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('; '));
    return result.design;
  }

  it('changes the name and nothing else', () => {
    const result = applyOps(parsed(), [{ op: 'rename', name: 'Sign in' }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.design.name).toBe('Sign in');
    // The tree is untouched, which is what makes this safe to fire on every
    // keystroke of a rename.
    expect(serializeDesign(result.design).trim()).toBe(
      SOURCE.replace('Untitled design', 'Sign in'),
    );
  });

  it('refuses a blank name rather than writing one', () => {
    // `name=""` parses and says nothing, which is worse than refusing.
    for (const name of ['', '   ', '\t']) {
      const result = applyOps(parsed(), [{ op: 'rename', name }]);
      expect(result.ok, JSON.stringify(name)).toBe(false);
    }
  });

  it('trims, so a trailing space does not become part of the name', () => {
    const result = applyOps(parsed(), [{ op: 'rename', name: '  Sign in  ' }]);
    expect(result.ok && result.design.name).toBe('Sign in');
  });

  it('composes with other ops in one batch', () => {
    const design = parsed();
    const frame = design.frames[0]!;
    const result = applyOps(design, [
      { op: 'rename', name: 'Sign in' },
      { op: 'insert', parent: frame.id, index: 0, layer: { kind: 'text', content: 'Hello' } },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.design.name).toBe('Sign in');
    expect(result.design.frames[0]!.children).toHaveLength(2);
  });

  it('survives a round trip through the parser', () => {
    const renamed = applyOps(parsed(), [{ op: 'rename', name: 'A & B' }]);
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    const again = parseDesign(serializeDesign(renamed.design));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.design.name).toBe('A & B');
  });
});
