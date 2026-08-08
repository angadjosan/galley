import type { NewLayer } from './ops.js';

/**
 * The things you can add to a design.
 *
 * `STARTERS` answers "what does a whole design look like"; this answers the
 * question immediately after it — "now what do I put *in* it". They are
 * different problems and the second one is the harder of the two, because it
 * recurs on every edit rather than once at the beginning.
 *
 * **The unit of insertion is a recognisable thing, not a primitive.** The
 * editor previously offered `+ Box` and `+ Text`, which is the correct
 * decomposition of the format and the wrong decomposition of the task. Nobody
 * sets out to add a box. They set out to add a *button*, and a button is a box
 * with padding, a radius, a fill, a hover state and a centred label — six
 * decisions, every one of which is a chance to produce something that looks
 * almost right. Offering the primitive means the person doing the least
 * design-literate work is handed the most design decisions.
 *
 * This is the one thing Canva genuinely does better than the professional
 * tools, and it is not the drag-and-drop: it is that the palette is full of
 * *finished objects*. You are never assembling a heading out of a rectangle.
 *
 * **Every block here is valid on arrival.** Each one lints clean, uses only the
 * closed vocabulary, and carries the classes that make it visible — a box with
 * no `flex` and no padding is a zero-height invisible rectangle, and an "add"
 * that appears to do nothing is worse than no button at all. That is the same
 * rule the `add` path already enforced for its two primitives, applied to
 * twelve real ones.
 *
 * **It lives in `@galley/design`, not in the app.** The canvas drags these onto
 * a frame; an agent asks for one by name. If the catalog lived in the editor
 * those would be two vocabularies that drift, and "add a primary button" would
 * mean something different depending on who typed it.
 */
export interface DesignBlock {
  readonly id: string;
  readonly label: string;
  /** What it is for, in the palette. One short phrase, no full stop. */
  readonly hint: string;
  /**
   * Which shelf of the palette it sits on.
   *
   * Four, and no more: a palette long enough to need scrolling is a palette
   * people stop reading. Ordered by how often the thing is reached for, not
   * alphabetically — `text` first because most edits start by saying something.
   */
  readonly group: 'text' | 'action' | 'input' | 'layout';
  /** The tree that gets inserted. */
  readonly layer: NewLayer;
}

export const BLOCKS: readonly DesignBlock[] = [
  // --------------------------------------------------------------- text
  {
    id: 'heading',
    label: 'Heading',
    hint: 'The name of the screen',
    group: 'text',
    layer: { kind: 'text', name: 'Heading', classes: ['text-h2', 'text-fg'], content: 'Heading' },
  },
  {
    id: 'subheading',
    label: 'Subheading',
    hint: 'A smaller title',
    group: 'text',
    layer: {
      kind: 'text',
      name: 'Subheading',
      classes: ['text-h3', 'text-fg'],
      content: 'Subheading',
    },
  },
  {
    id: 'paragraph',
    label: 'Paragraph',
    hint: 'A line of body text',
    group: 'text',
    layer: {
      kind: 'text',
      name: 'Text',
      classes: ['text-body', 'text-fg'],
      content: 'Say something here.',
    },
  },
  {
    id: 'caption',
    label: 'Caption',
    hint: 'Quiet supporting text',
    group: 'text',
    layer: {
      kind: 'text',
      name: 'Caption',
      classes: ['text-small', 'text-fg-muted'],
      content: 'Supporting detail.',
    },
  },

  // ------------------------------------------------------------- action
  {
    id: 'button',
    label: 'Button',
    hint: 'The main thing to press',
    group: 'action',
    layer: {
      kind: 'box',
      name: 'Button',
      // The hover and pressed states ship with it. A button that does not
      // respond to a cursor reads as a coloured rectangle, and remembering to
      // add two state classes by hand is exactly the kind of thing the palette
      // exists to stop being anyone's job.
      classes: [
        'flex',
        'items-center',
        'justify-center',
        'h-40',
        'px-4',
        'bg-accent',
        'rounded-md',
        'hover:bg-accent-hover',
        'press:bg-accent-pressed',
      ],
      children: [
        {
          kind: 'text',
          name: 'Label',
          classes: ['text-body', 'font-semibold', 'text-on-accent'],
          content: 'Continue',
        },
      ],
    },
  },
  {
    id: 'quiet-button',
    label: 'Quiet button',
    hint: 'The other option',
    group: 'action',
    layer: {
      kind: 'box',
      name: 'Quiet button',
      classes: [
        'flex',
        'items-center',
        'justify-center',
        'h-40',
        'px-4',
        'bg-surface',
        'border',
        'border-border',
        'rounded-md',
        'hover:bg-raised',
      ],
      children: [
        { kind: 'text', name: 'Label', classes: ['text-body', 'text-fg'], content: 'Back' },
      ],
    },
  },
  {
    id: 'button-pair',
    label: 'Two buttons',
    hint: 'Back and continue, side by side',
    group: 'action',
    layer: {
      kind: 'box',
      name: 'Actions',
      classes: ['flex', 'flex-row', 'gap-3'],
      children: [
        {
          kind: 'box',
          name: 'Quiet button',
          classes: [
            'flex',
            'grow',
            'items-center',
            'justify-center',
            'h-40',
            'px-4',
            'bg-surface',
            'border',
            'border-border',
            'rounded-md',
            'hover:bg-raised',
          ],
          children: [
            { kind: 'text', name: 'Label', classes: ['text-body', 'text-fg'], content: 'Back' },
          ],
        },
        {
          kind: 'box',
          name: 'Button',
          classes: [
            'flex',
            'grow',
            'items-center',
            'justify-center',
            'h-40',
            'px-4',
            'bg-accent',
            'rounded-md',
            'hover:bg-accent-hover',
            'press:bg-accent-pressed',
          ],
          children: [
            {
              kind: 'text',
              name: 'Label',
              classes: ['text-body', 'font-semibold', 'text-on-accent'],
              content: 'Continue',
            },
          ],
        },
      ],
    },
  },

  // -------------------------------------------------------------- input
  {
    id: 'field',
    label: 'Text field',
    hint: 'A label and a box to type in',
    group: 'input',
    layer: {
      kind: 'box',
      name: 'Field',
      classes: ['flex', 'flex-col', 'gap-1'],
      children: [
        {
          kind: 'text',
          name: 'Label',
          classes: ['text-label', 'text-fg-muted'],
          content: 'Label',
        },
        {
          kind: 'box',
          name: 'Input',
          classes: [
            'flex',
            'flex-row',
            'items-center',
            'h-44',
            'px-3',
            'bg-surface',
            'border',
            'border-border',
            'rounded-md',
            'focus:border-accent',
          ],
          children: [
            {
              kind: 'text',
              name: 'Placeholder',
              classes: ['text-body', 'text-fg-subtle'],
              content: 'Placeholder',
            },
          ],
        },
      ],
    },
  },
  {
    id: 'field-pair',
    label: 'Two fields',
    hint: 'Side by side, like expiry and code',
    group: 'input',
    layer: {
      kind: 'box',
      name: 'Fields',
      classes: ['flex', 'flex-row', 'gap-3'],
      children: [
        {
          kind: 'box',
          name: 'Field',
          classes: ['flex', 'flex-col', 'gap-1', 'grow'],
          children: [
            { kind: 'text', name: 'Label', classes: ['text-label', 'text-fg-muted'], content: 'Label' },
            {
              kind: 'box',
              name: 'Input',
              classes: [
                'flex',
                'flex-row',
                'items-center',
                'h-44',
                'px-3',
                'bg-surface',
                'border',
                'border-border',
                'rounded-md',
                'focus:border-accent',
              ],
              children: [
                {
                  kind: 'text',
                  name: 'Placeholder',
                  classes: ['text-body', 'text-fg-subtle'],
                  content: 'Placeholder',
                },
              ],
            },
          ],
        },
        {
          kind: 'box',
          name: 'Field',
          classes: ['flex', 'flex-col', 'gap-1', 'grow'],
          children: [
            { kind: 'text', name: 'Label', classes: ['text-label', 'text-fg-muted'], content: 'Label' },
            {
              kind: 'box',
              name: 'Input',
              classes: [
                'flex',
                'flex-row',
                'items-center',
                'h-44',
                'px-3',
                'bg-surface',
                'border',
                'border-border',
                'rounded-md',
                'focus:border-accent',
              ],
              children: [
                {
                  kind: 'text',
                  name: 'Placeholder',
                  classes: ['text-body', 'text-fg-subtle'],
                  content: 'Placeholder',
                },
              ],
            },
          ],
        },
      ],
    },
  },

  // ------------------------------------------------------------- layout
  {
    id: 'card',
    label: 'Card',
    hint: 'A titled box for a group of things',
    group: 'layout',
    layer: {
      kind: 'box',
      name: 'Card',
      classes: [
        'flex',
        'flex-col',
        'gap-2',
        'p-4',
        'bg-surface',
        'border',
        'border-border',
        'rounded-lg',
      ],
      children: [
        { kind: 'text', name: 'Title', classes: ['text-h3', 'text-fg'], content: 'Card title' },
        {
          kind: 'text',
          name: 'Body',
          classes: ['text-small', 'text-fg-muted'],
          content: 'What this card is about.',
        },
      ],
    },
  },
  {
    id: 'row',
    label: 'Row',
    hint: 'Things side by side',
    group: 'layout',
    layer: {
      kind: 'box',
      name: 'Row',
      classes: ['flex', 'flex-row', 'gap-3', 'items-center'],
      children: [
        { kind: 'text', name: 'Text', classes: ['text-body', 'text-fg'], content: 'One' },
        { kind: 'text', name: 'Text', classes: ['text-body', 'text-fg'], content: 'Two' },
      ],
    },
  },
  {
    id: 'column',
    label: 'Column',
    hint: 'Things stacked',
    group: 'layout',
    layer: {
      kind: 'box',
      name: 'Column',
      classes: ['flex', 'flex-col', 'gap-3'],
      children: [
        { kind: 'text', name: 'Text', classes: ['text-body', 'text-fg'], content: 'One' },
        { kind: 'text', name: 'Text', classes: ['text-body', 'text-fg'], content: 'Two' },
      ],
    },
  },
  {
    id: 'split',
    label: 'Split row',
    hint: 'One thing left, one thing right',
    group: 'layout',
    layer: {
      kind: 'box',
      name: 'Split',
      classes: ['flex', 'flex-row', 'items-center', 'justify-between', 'gap-3'],
      children: [
        { kind: 'text', name: 'Left', classes: ['text-body', 'text-fg'], content: 'Total' },
        {
          kind: 'text',
          name: 'Right',
          classes: ['text-body', 'font-semibold', 'text-fg'],
          content: '$42.00',
        },
      ],
    },
  },
  {
    id: 'divider',
    label: 'Divider',
    hint: 'A line between sections',
    group: 'layout',
    layer: { kind: 'box', name: 'Divider', classes: ['h-1', 'bg-border'] },
  },
];

/** One block by id. `undefined` rather than a throw — callers decide. */
export function blockById(id: string): DesignBlock | undefined {
  return BLOCKS.find((block) => block.id === id);
}
