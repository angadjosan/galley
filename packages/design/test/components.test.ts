/**
 * Twelve buttons that are the same button.
 *
 * A component is what makes a design system a system rather than a folder, and
 * the decision the tests below are really about is that **the authored tree and
 * the drawn tree are different trees**. The file holds twelve `<use>` lines; the
 * browser needs twelve copies. Everything except the renderer works on the
 * authored one, so the interesting failures are all at that seam: an expanded
 * id reaching an op, a definition edited through an instance, a slot value
 * landing in the definition instead of on the use.
 */
import { describe, expect, it } from 'vitest';
import { applyOps } from '../src/ops.js';
import { expandDesign, isExpanded, slotsOf, useOf, usesOf } from '../src/expand.js';
import { lintDesign } from '../src/lint.js';
import { parseDesign } from '../src/parse.js';
import { serializeDesign } from '../src/serialize.js';
import { find, walk, type DesignDocument, type Layer } from '../src/types.js';

function design(markup: string): DesignDocument {
  const result = parseDesign(markup);
  if (!result.ok) throw new Error(result.errors.map((error) => error.message).join('; '));
  return result.design;
}

/**
 * The text layers actually on a frame.
 *
 * `walk` yields the definitions too — deliberately, so an id lookup finds a
 * layer inside one — so a test about what is *drawn* has to say so.
 */
function drawnTexts(drawn: DesignDocument): Layer[] {
  const found: Layer[] = [];
  const descend = (layer: Layer): void => {
    if (layer.kind === 'text') found.push(layer);
    if (layer.kind === 'box') layer.children.forEach(descend);
  };
  for (const frame of drawn.frames) frame.children.forEach(descend);
  return found;
}

function drawnWords(drawn: DesignDocument): string[] {
  return drawnTexts(drawn).map((layer) => (layer as { content: string }).content);
}

function errorsOf(markup: string): string[] {
  const result = parseDesign(markup);
  return result.ok ? [] : result.errors.map((error) => error.message);
}

const SOURCE = [
  '<design name="Kit">',
  '  <define name="Button">',
  '    <box class="flex items-center justify-center h-40 px-4 bg-accent rounded-md">',
  '      <text name="slot:label" class="text-body text-on-accent">Button</text>',
  '    </box>',
  '  </define>',
  '  <frame name="Screen" width="320" class="flex flex-col gap-3 p-4 bg-canvas">',
  '    <use component="Button" label="Pay $42.00" />',
  '    <use class="grow" component="Button" label="Cancel" />',
  '  </frame>',
  '</design>',
].join('\n');

const KIT = design(SOURCE);

describe('what the file holds', () => {
  it('keeps definitions out of the frames', () => {
    // A definition drawn on the canvas would appear as a stray card floating
    // beside the design, and there is no honest place to put it.
    expect(KIT.components).toHaveLength(1);
    expect(KIT.frames).toHaveLength(1);
    expect(KIT.frames[0]!.children.every((child) => child.kind === 'use')).toBe(true);
  });

  it('numbers a definition in its own namespace', () => {
    // Reusing the frame numbering would give a component's root the same id as
    // the first frame's first child — a collision that makes a design
    // unparseable, which this codebase has already had once.
    const ids = [...walk(KIT)].map((entry) => entry.layer.id);
    expect(new Set(ids).size, ids.join(' ')).toBe(ids.length);
    expect(KIT.components![0]!.layer.id).toMatch(/^l_c0/);
  });

  it('reads every non-structural attribute of a use as a slot value', () => {
    const [first, second] = KIT.frames[0]!.children as [Layer, Layer];
    expect(first.kind === 'use' && first.slots).toEqual({ label: 'Pay $42.00' });
    // `class` is the instance's own, not a slot.
    expect(second.kind === 'use' && second.slots).toEqual({ label: 'Cancel' });
    expect(second.classes).toEqual(['grow']);
  });

  it('writes back exactly what it read', () => {
    expect(serializeDesign(KIT)).toBe(`${SOURCE}\n`);
  });

  it.each([
    [
      'a define inside a frame',
      '<design name="x"><frame width="100"><define name="B"><box></box></define></frame></design>',
      /not inside a frame/,
    ],
    [
      'a define with two roots',
      '<design name="x"><define name="B"><box></box><box></box></define><frame width="100"></frame></design>',
      /two roots is two components/,
    ],
    [
      'two components with one name',
      '<design name="x"><define name="B"><box></box></define><define name="B"><box></box></define><frame width="100"></frame></design>',
      /Two components are called/,
    ],
    ['a use with no component', '<design name="x"><frame width="100"><use /></frame></design>', /needs a `component`/],
  ])('refuses %s', (_name, markup, message) => {
    expect(errorsOf(markup).join(' ')).toMatch(message);
  });

  it('accepts a use written before the define it names', () => {
    // A parser that refused a forward reference would make file order
    // load-bearing, which is why the *linter* owns this check and not the
    // parser.
    expect(
      errorsOf(
        [
          '<design name="x">',
          '  <frame width="100"><use component="B" /></frame>',
          '  <define name="B"><box class="flex"></box></define>',
          '</design>',
        ].join('\n'),
      ),
    ).toEqual([]);
  });
});

describe('what gets drawn', () => {
  const drawn = expandDesign(KIT);

  it('replaces each use with a copy of the definition', () => {
    const first = drawn.frames[0]!.children[0]!;
    expect(first.kind).toBe('box');
    expect(first.kind === 'box' && first.children[0]!.kind).toBe('text');
  });

  it('fills the slots, and each instance differently', () => {
    expect(drawnWords(drawn)).toEqual(['Pay $42.00', 'Cancel']);
  });

  it('lets the instance win over the definition, because position is not identity', () => {
    // `grow` on this one and not that one is a fact about the layout around it.
    // Pushing it into the definition would mean a second definition per place a
    // button can sit.
    const second = drawn.frames[0]!.children[1]!;
    expect(second.classes).toContain('bg-accent');
    expect(second.classes.at(-1)).toBe('grow');
  });

  it('marks every id it invented as one the ops must not accept', () => {
    // The seam. An expanded id reaching an op would edit a layer nobody
    // authored, so the shape is chosen to be impossible for the parser to
    // produce — a crash rather than a silent edit of the wrong thing.
    const label = drawnTexts(drawn)[0]!;
    expect(isExpanded(label.id)).toBe(true);
    expect(useOf(label.id)).toBe(KIT.frames[0]!.children[0]!.id);
    expect(applyOps(KIT, [{ op: 'set-text', id: label.id, content: 'x' }]).ok).toBe(false);
  });

  it('keeps the use’s own id, so a click still lands on something real', () => {
    expect(drawn.frames[0]!.children[0]!.id).toBe(KIT.frames[0]!.children[0]!.id);
    expect(find(KIT, drawn.frames[0]!.children[0]!.id)).not.toBeNull();
  });

  it('draws an empty box for a component that is not there', () => {
    // Rather than nothing at all: the layer keeps a rect, so it can be
    // selected, deleted, and told what is wrong with it. A use that vanishes is
    // a use nobody can fix.
    const missing = expandDesign(design('<design name="x"><frame width="100"><use component="Gone" /></frame></design>'));
    expect(missing.frames[0]!.children[0]!.kind).toBe('box');
  });

  it('survives a component that uses itself', () => {
    // The linter explains it; this only has to not hang, because a canvas that
    // crashes while you are typing a name is worse than one that draws nothing.
    const loop = design(
      [
        '<design name="x">',
        '  <define name="A"><box class="flex"><use component="A" /></box></define>',
        '  <frame width="100"><use component="A" /></frame>',
        '</design>',
      ].join('\n'),
    );
    expect(() => expandDesign(loop)).not.toThrow();
  });
});

describe('changing one', () => {
  it('changes every use when the definition changes', () => {
    // The entire point. One edit, twelve buttons.
    const applied = applyOps(KIT, [
      { op: 'set-classes', id: KIT.components![0]!.layer.id, classes: ['flex', 'h-40', 'bg-danger'] },
    ]);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const drawn = expandDesign(applied.design);
    expect(drawn.frames[0]!.children.every((child) => child.classes.includes('bg-danger'))).toBe(true);
  });

  it('changes one use when a slot changes', () => {
    const target = KIT.frames[0]!.children[0]!.id;
    const applied = applyOps(KIT, [{ op: 'set-slot', id: target, slot: 'label', value: 'Pay now' }]);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(drawnWords(expandDesign(applied.design))).toEqual(['Pay now', 'Cancel']);
  });

  it('clears an override rather than blanking it', () => {
    // Null is "whatever the component says"; empty string is "nothing at all",
    // and a label cleared by accident has to be recoverable.
    const target = KIT.frames[0]!.children[0]!.id;
    const applied = applyOps(KIT, [{ op: 'set-slot', id: target, slot: 'label', value: null }]);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const first = applied.design.frames[0]!.children[0]!;
    expect(first.kind === 'use' && first.slots).toEqual({});
    expect(serializeDesign(applied.design)).toContain('<use component="Button" />');
  });

  it('refuses a slot on something that is not a use', () => {
    const applied = applyOps(KIT, [
      { op: 'set-slot', id: KIT.components![0]!.layer.id, slot: 'label', value: 'x' },
    ]);
    expect(applied.ok).toBe(false);
    expect(!applied.ok && applied.errors.join(' ')).toMatch(/has no slots/);
  });

  it('keeps the definitions through an unrelated edit', () => {
    const applied = applyOps(KIT, [{ op: 'set-name', id: KIT.frames[0]!.id, name: 'Renamed' }]);
    expect(applied.ok && applied.design.components).toHaveLength(1);
  });
});

describe('what the linter catches', () => {
  it('a component nobody defined, and says what there is', () => {
    const orphan = design('<design name="x"><frame width="100" class="flex"><use component="Ghost" /></frame></design>');
    const messages = lintDesign(orphan).map((finding) => finding.message);
    expect(messages.join(' ')).toMatch(/No component is called `Ghost`/);
    expect(messages.join(' '), 'the message has to say what to do next').toMatch(/Define one with/);
  });

  it('a slot the component does not offer, and lists the ones it does', () => {
    const typo = design(SOURCE.replace('label="Pay $42.00"', 'lable="Pay $42.00"'));
    const message = lintDesign(typo).map((finding) => finding.message).join(' ');
    expect(message).toMatch(/has no slot called `lable`/);
    expect(message).toMatch(/It offers `label`/);
  });

  it('a component that uses itself', () => {
    const loop = design(
      [
        '<design name="x">',
        '  <define name="A"><box class="flex"><use component="A" /></box></define>',
        '  <frame width="100" class="flex"><use component="A" /></frame>',
        '</design>',
      ].join('\n'),
    );
    expect(lintDesign(loop).map((one) => one.message).join(' ')).toMatch(/uses itself/);
  });

  it('says nothing about a design that is fine', () => {
    expect(lintDesign(KIT)).toEqual([]);
  });
});

describe('the ways a component can lie', () => {
  it('gives two instances of a nested component different ids', () => {
    // The seam, at its sharpest. Expanding a nested use against its own
    // definition-local id made both instances of the outer component produce
    // identical ids for everything inside the inner one — so one instance's
    // measured rect overwrote the other's, and a click resolved to a layer
    // inside the *definition*, where an edit changes every instance at once.
    const nested = design(
      [
        '<design name="x">',
        '  <define name="Inner"><box class="flex"><text name="slot:label" class="text-body">hi</text></box></define>',
        '  <define name="Outer"><box class="flex"><use component="Inner" /></box></define>',
        '  <frame width="390" class="flex flex-col"><use component="Outer" /><use component="Outer" /></frame>',
        '</design>',
      ].join('\n'),
    );
    const ids = drawnTexts(expandDesign(nested)).map((layer) => layer.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size, ids.join(' ')).toBe(2);
    // And each maps back to a use that is actually on the frame.
    for (const id of ids) {
      expect(nested.frames[0]!.children.some((child) => child.id === useOf(id))).toBe(true);
    }
  });

  it('refuses a slot named after one of a use’s own attributes', () => {
    // `slot:id` was read as the layer's identity: the override became a durable
    // id nobody asked for, and the value was destroyed on the next save.
    const clash = design(
      [
        '<design name="x">',
        '  <define name="B"><box class="flex"><text name="slot:id" class="text-body">a</text></box></define>',
        '  <frame width="390" class="flex"><use component="B" /></frame>',
        '</design>',
      ].join('\n'),
    );
    expect(lintDesign(clash).map((one) => one.message).join(' ')).toMatch(/cannot be a slot/);
  });

  it('refuses a slot on something that is not text', () => {
    // Nothing substitutes it, so the inspector offered a field that wrote a
    // real attribute to the file and changed nothing on screen.
    const wrong = design(
      [
        '<design name="x">',
        '  <define name="Card"><box name="slot:body" class="flex"><text class="text-body">x</text></box></define>',
        '  <frame width="390" class="flex"><use component="Card" /></frame>',
        '</design>',
      ].join('\n'),
    );
    const messages = lintDesign(wrong).map((one) => one.message).join(' ');
    expect(messages).toMatch(/only text can be filled in/);
    expect(slotsOf(wrong.components![0]!), 'a slot nothing honours must not be offered').toEqual([]);
  });

  it('refuses to delete a component’s root rather than doing nothing', () => {
    // It has no parent to detach from, so the op reported success and left the
    // file byte-identical — an affordance that appears to work and does not.
    const before = serializeDesign(KIT);
    const applied = applyOps(KIT, [{ op: 'delete', id: KIT.components![0]!.layer.id }]);
    expect(applied.ok).toBe(false);
    expect(!applied.ok && applied.errors.join(' ')).toMatch(/Remove its `<define>`/);
    expect(serializeDesign(KIT)).toBe(before);
  });

  it('treats a slot called __proto__ as a slot', () => {
    const target = KIT.frames[0]!.children[0]!.id;
    const applied = applyOps(KIT, [{ op: 'set-slot', id: target, slot: '__proto__', value: 'x' }]);
    expect(applied.ok).toBe(true);
    const first = applied.ok ? applied.design.frames[0]!.children[0]! : null;
    expect(first?.kind === 'use' && Object.keys(first.slots)).toEqual(['label', '__proto__']);
  });

  it('refuses an authored id containing the character that marks an expanded one', () => {
    const result = parseDesign('<design name="x"><frame width="100"><box id="a$b" class="flex"></box></frame></design>');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.map((e) => e.message).join(' ')).toMatch(/cannot contain/);
  });

  it('does not add a name to a line nobody touched when a box loses its last child', () => {
    // The invented name for a box depends on its child count, so deleting the
    // last child flipped it from "Group" to "Box" and the serializer started
    // writing `name="Group"` onto an untouched line.
    const box = design(
      '<design name="x"><frame width="100" class="flex"><box class="flex"><text class="text-body">x</text></box></frame></design>',
    );
    const applied = applyOps(box, [{ op: 'delete', id: 'l_0_0_0' }]);
    expect(applied.ok).toBe(true);
    const line = applied.ok
      ? serializeDesign(applied.design).split('\n').find((one) => one.includes('<box'))
      : '';
    expect(line?.trim()).toBe('<box class="flex"></box>');
  });
});

describe('reading a component', () => {
  it('lists the slots it offers', () => {
    expect(slotsOf(KIT.components![0]!)).toEqual(['label']);
  });

  it('lists where it is used, which is what "would this break anything" means', () => {
    expect(usesOf(KIT, 'Button')).toHaveLength(2);
    expect(usesOf(KIT, 'Nothing')).toEqual([]);
  });
});
