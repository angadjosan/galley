/**
 * Designs to start from.
 *
 * Same reasoning as the diagram gallery: a blank canvas is a churn surface, and
 * "learn a layout vocabulary from nothing" is a different task from the one the
 * writer came to do. Every starter here is a real, lintable design using only
 * the closed vocabulary, so the first edit is renaming a label — and so the
 * file doubles as worked examples an agent can read to learn the format.
 */
export interface DesignStarter {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly source: string;
}

export const STARTERS: readonly DesignStarter[] = [
  {
    id: 'blank',
    label: 'Blank frame',
    hint: 'An empty screen',
    source: [
      '<design name="Untitled design">',
      '  <frame name="Screen" width="390" class="flex flex-col gap-4 p-6 bg-canvas">',
      '    <text class="text-h2 text-fg">Title</text>',
      '    <text class="text-body text-fg-muted">Say what this screen is for.</text>',
      '  </frame>',
      '</design>',
    ].join('\n'),
  },
  {
    id: 'form',
    label: 'Form',
    hint: 'Fields and a button',
    source: [
      '<design name="Payment">',
      '  <frame name="Payment / default" width="390" class="flex flex-col gap-6 p-6 bg-canvas">',
      '    <text class="text-h2 text-fg">Payment</text>',
      '    <box name="Card field" class="flex flex-col gap-1">',
      '      <text class="text-label text-fg-muted">Card number</text>',
      '      <box class="flex flex-row items-center h-44 px-3 bg-surface border border-border rounded-md">',
      '        <text class="text-body text-fg-subtle">4242 4242 4242 4242</text>',
      '      </box>',
      '    </box>',
      '    <box name="Expiry and code" class="flex flex-row gap-3">',
      '      <box class="flex flex-col gap-1 grow">',
      '        <text class="text-label text-fg-muted">Expires</text>',
      '        <box class="flex flex-row items-center h-44 px-3 bg-surface border border-border rounded-md">',
      '          <text class="text-body text-fg-subtle">MM / YY</text>',
      '        </box>',
      '      </box>',
      '      <box class="flex flex-col gap-1 grow">',
      '        <text class="text-label text-fg-muted">Security code</text>',
      '        <box class="flex flex-row items-center h-44 px-3 bg-surface border border-border rounded-md">',
      '          <text class="text-body text-fg-subtle">123</text>',
      '        </box>',
      '      </box>',
      '    </box>',
      '    <box name="Pay button" class="flex items-center justify-center h-48 bg-accent rounded-md">',
      '      <text class="text-body font-semibold text-on-accent">Pay $42.00</text>',
      '    </box>',
      '  </frame>',
      '</design>',
    ].join('\n'),
  },
  {
    id: 'card',
    label: 'Cards',
    hint: 'A list of items',
    source: [
      '<design name="Cards">',
      '  <frame name="List" width="520" class="flex flex-col gap-3 p-6 bg-canvas">',
      '    <text class="text-h2 text-fg">Recent documents</text>',
      '    <box name="Card" class="flex flex-row items-center gap-4 p-4 bg-surface border border-border rounded-lg shadow-sm">',
      '      <box class="w-40 h-40 bg-accent-soft rounded-md shrink-0"></box>',
      '      <box class="flex flex-col gap-1 grow">',
      '        <text class="text-h3 text-fg">Checkout v2</text>',
      '        <text class="text-small text-fg-muted">Edited by Priya, 2 hours ago</text>',
      '      </box>',
      '      <box class="flex items-center justify-center h-32 px-4 border border-border rounded-full">',
      '        <text class="text-label text-fg-muted">Open</text>',
      '      </box>',
      '    </box>',
      '    <box name="Card" class="flex flex-row items-center gap-4 p-4 bg-surface border border-border rounded-lg shadow-sm">',
      '      <box class="w-40 h-40 bg-warn-soft rounded-md shrink-0"></box>',
      '      <box class="flex flex-col gap-1 grow">',
      '        <text class="text-h3 text-fg">Refund policy</text>',
      '        <text class="text-small text-fg-muted">Stale — last checked 3 weeks ago</text>',
      '      </box>',
      '      <box class="flex items-center justify-center h-32 px-4 border border-border rounded-full">',
      '        <text class="text-label text-fg-muted">Open</text>',
      '      </box>',
      '    </box>',
      '  </frame>',
      '</design>',
    ].join('\n'),
  },
  {
    id: 'states',
    label: 'States',
    hint: 'One component, several ways',
    source: [
      '<design name="Button states">',
      '  <frame name="Button" width="420" class="flex flex-col gap-4 p-6 bg-canvas">',
      '    <text class="text-label text-fg-muted">Default</text>',
      '    <box class="flex items-center justify-center h-40 px-5 bg-accent rounded-md">',
      '      <text class="text-body font-semibold text-on-accent">Continue</text>',
      '    </box>',
      '    <text class="text-label text-fg-muted">Secondary</text>',
      '    <box class="flex items-center justify-center h-40 px-5 bg-surface border border-border-strong rounded-md">',
      '      <text class="text-body font-medium text-fg">Continue</text>',
      '    </box>',
      '    <text class="text-label text-fg-muted">Disabled</text>',
      '    <box class="flex items-center justify-center h-40 px-5 bg-sunken rounded-md opacity-60">',
      '      <text class="text-body font-medium text-fg-muted">Continue</text>',
      '    </box>',
      '    <text class="text-label text-fg-muted">Destructive</text>',
      '    <box class="flex items-center justify-center h-40 px-5 bg-danger rounded-md">',
      '      <text class="text-body font-semibold text-on-accent">Delete for everyone</text>',
      '    </box>',
      '  </frame>',
      '</design>',
    ].join('\n'),
  },
];
