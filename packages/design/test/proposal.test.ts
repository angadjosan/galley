/**
 * What an agent is allowed to do to a design.
 *
 * These tests are about the border rather than about the edit. Everything here
 * arrives as JSON from something that may be wrong, may be confused about which
 * ids exist, and may — asked to change a label — return a batch that rewrites
 * the file. The two questions are "is this an op" and "is applying it a good
 * idea", and they are tested separately because they fail for different reasons
 * and produce different advice.
 */
import { describe, expect, it } from 'vitest';
import { parseDesign } from '../src/parse.js';
import { parseOps, vet, DEFAULT_LIMITS } from '../src/proposal.js';
import type { DesignDocument } from '../src/types.js';

function design(markup: string): DesignDocument {
  const result = parseDesign(markup);
  if (!result.ok) throw new Error(result.errors.map((error) => error.message).join('; '));
  return result.design;
}

const FORM = design(
  [
    '<design name="Payment">',
    '  <frame name="Payment" width="390" class="flex flex-col gap-4 p-6 bg-canvas">',
    '    <text name="Title" class="text-h2 text-fg">Payment</text>',
    '    <box name="Field" class="flex flex-col gap-1">',
    '      <text name="Label" class="text-label text-fg-muted">Card number</text>',
    '    </box>',
    '    <box name="Pay" class="flex items-center justify-center h-48 bg-accent rounded-md">',
    '      <text name="Pay label" class="text-body text-on-accent">Pay $42.00</text>',
    '    </box>',
    '  </frame>',
    '</design>',
  ].join('\n'),
);

describe('is this an op', () => {
  it('takes a bare array or an object with ops', () => {
    const bare = parseOps([{ op: 'set-name', id: 'l_0_0', name: 'Heading' }]);
    const wrapped = parseOps({ ops: [{ op: 'set-name', id: 'l_0_0', name: 'Heading' }] });
    expect(bare.ok && bare.ops).toHaveLength(1);
    expect(wrapped.ok && wrapped.ops).toHaveLength(1);
  });

  it('keeps the intent when one is given', () => {
    // Required on an agent's ops for a reason no diff can supply: a reviewer
    // looking at eleven class changes needs to know what it was trying to do.
    const result = parseOps([
      { intent: 'make the button read as the primary action', op: { op: 'set-classes', id: 'l_0_2', classes: ['bg-accent'] } },
    ]);
    expect(result.ok && result.ops[0]?.intent).toBe('make the button read as the primary action');
  });

  it.each([
    ['not an array', { some: 'thing' }, /array of ops/],
    ['empty', [], /changes nothing/],
    ['an unknown op', [{ op: 'set-colour', id: 'l_0' }], /is not an op/],
    ['a missing id', [{ op: 'delete' }], /must be the id of a layer/],
    ['classes that are not strings', [{ op: 'set-classes', id: 'l_0', classes: [1] }], /array of class names/],
    ['a fractional index', [{ op: 'move', id: 'l_0_1', parent: 'l_0', index: 1.5 }], /whole number/],
    ['a frame width that is a string', [{ op: 'set-frame', id: 'l_0', width: '390' }], /number of pixels/],
  ])('refuses %s', (_name, input, message) => {
    const result = parseOps(input as unknown);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.join(' ')).toMatch(message);
  });

  it('takes a slot override, and a null to clear one', () => {
    const set = parseOps([{ op: 'set-slot', id: 'l_0_1', slot: 'label', value: 'Pay' }]);
    const clear = parseOps([{ op: 'set-slot', id: 'l_0_1', slot: 'label', value: null }]);
    expect(set.ok && set.ops[0]!.op).toEqual({ op: 'set-slot', id: 'l_0_1', slot: 'label', value: 'Pay' });
    // Null is "whatever the component says", which is not the empty string.
    expect(clear.ok && (clear.ops[0]!.op as { value: unknown }).value).toBeNull();
  });

  it('refuses an image with no description, rather than merely warning', () => {
    // A lint warning is for something already in the file. An image being
    // *added* right now with no alt is a hole nobody will come back and fill,
    // and the description is the only part of it an agent can read.
    const result = parseOps([
      { op: 'insert', parent: 'l_0', index: 0, layer: { kind: 'image', src: '/a.png' } },
    ]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.join(' ')).toMatch(/description is not optional/);
  });

  it('names the op that was wrong, and says what was expected', () => {
    // The reader is usually a model that will try again, and "invalid input" is
    // the message that guarantees the second attempt is another guess.
    const result = parseOps([
      { op: 'set-name', id: 'l_0_0', name: 'Fine' },
      { op: 'set-text', id: 'l_0_0', content: 42 },
    ]);
    expect(!result.ok && result.errors[0]).toMatch(/^op 2 \(set-text\): `content` must be a string/);
  });

  it('refuses a batch too big to review before looking at any of it', () => {
    const many = Array.from({ length: DEFAULT_LIMITS.maxOps + 1 }, () => ({
      op: 'set-name',
      id: 'l_0_0',
      name: 'x',
    }));
    const result = parseOps(many);
    expect(!result.ok && result.errors[0]).toMatch(/Split it/);
  });
});

describe('is applying it a good idea', () => {
  it('lets an ordinary edit through, and reports what it fixed', () => {
    const ops = parseOps([{ op: 'set-text', id: 'l_0_2_0', content: 'Pay now' }]);
    expect(ops.ok).toBe(true);
    const result = vet(FORM, ops.ok ? ops.ops : []);
    expect(result.ok).toBe(true);
    expect(result.ok && result.result.introduced).toEqual([]);
  });

  it('refuses a change that would break something', () => {
    // Making the pay label the same ink as its background is legal markup, a
    // legal op, and unreadable. Nothing but a check that resolves the palette
    // catches it, and nothing that runs after the fact catches it in time.
    const ops = parseOps([{ op: 'set-classes', id: 'l_0_2_0', classes: ['text-body', 'text-accent'] }]);
    const result = vet(FORM, ops.ok ? ops.ops : []);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.join(' ')).toMatch(/would break something/);
  });

  it('judges the change, not the design it arrived in', () => {
    // A design that already fails must still be editable. Refusing on absolute
    // cleanliness is how a safety check becomes the thing everyone turns off.
    const broken = design(
      [
        '<design name="x">',
        '  <frame width="390" class="flex flex-col p-4 bg-canvas">',
        '    <text name="Faint" class="text-body text-canvas">Invisible</text>',
        '    <text name="Fine" class="text-body text-fg">Readable</text>',
        '  </frame>',
        '</design>',
      ].join('\n'),
    );
    const ops = parseOps([{ op: 'set-text', id: 'l_0_1', content: 'Still readable' }]);
    const result = vet(broken, ops.ok ? ops.ops : []);
    expect(result.ok, 'an unrelated pre-existing failure blocked an unrelated edit').toBe(true);
  });

  it('reports a finding the change resolved', () => {
    // The half a diff never shows. A reviewer cannot see that one of eleven
    // class changes fixed a contrast failure, and that is the most useful thing
    // to tell them.
    const broken = design(
      [
        '<design name="x">',
        '  <frame width="390" class="flex flex-col p-4 bg-canvas">',
        '    <text name="Faint" class="text-body text-canvas">Invisible</text>',
        '  </frame>',
        '</design>',
      ].join('\n'),
    );
    const ops = parseOps([{ op: 'set-classes', id: 'l_0_0', classes: ['text-body', 'text-fg'] }]);
    const result = vet(broken, ops.ok ? ops.ops : []);
    expect(result.ok && result.result.resolved.length).toBeGreaterThan(0);
  });

  it('passes an op refusal through untranslated', () => {
    // `applyOps` is all-or-nothing, so a batch naming a layer that is not there
    // leaves the design untouched — and its reason is better than anything this
    // layer could invent on top of it.
    const ops = parseOps([{ op: 'delete', id: 'l_9_9' }]);
    const result = vet(FORM, ops.ok ? ops.ops : []);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.join(' ')).toMatch(/l_9_9/);
  });

  it('refuses a rewrite wearing a batch’s clothes', () => {
    // Deleting the whole form one layer at a time is still deleting the form.
    // The churn ceiling counts a delete for what it actually costs — its whole
    // subtree — so the batch cannot hide behind a small op count.
    const ops = parseOps([
      { op: 'delete', id: 'l_0_1' },
      { op: 'delete', id: 'l_0_2' },
    ]);
    const result = vet(FORM, ops.ok ? ops.ops : []);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.join(' ')).toMatch(/rewrite rather than an edit/);
  });

  it('measures restyling as free, because a reviewer can read it', () => {
    // Twelve class swaps is a big change and a legible one. It is moving,
    // adding and deleting that makes a diff unreadable, because after the first
    // one the ids stop lining up and everything below looks new.
    const ops = parseOps([
      { op: 'set-classes', id: 'l_0_0', classes: ['text-h2', 'text-fg'] },
      { op: 'set-classes', id: 'l_0_1', classes: ['flex', 'flex-col', 'gap-2'] },
      { op: 'set-classes', id: 'l_0_2', classes: ['flex', 'items-center', 'h-48', 'bg-accent'] },
    ]);
    const result = vet(FORM, ops.ok ? ops.ops : []);
    expect(result.ok && result.result.churn).toBe(0);
  });
});
