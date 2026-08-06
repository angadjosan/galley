import { encode } from './parse.js';
import type { DesignDocument, Frame, Layer } from './types.js';

/**
 * Writing a design back out.
 *
 * One node per line, two spaces of indent, attributes in a fixed order. All
 * three are chosen for the diff rather than for the eye: a design edited in the
 * canvas has to produce a change a human can review, and the reviewable unit is
 * a line. Attribute order that varied with insertion order would rewrite lines
 * nobody touched, which is the same failure the prose serializer exists to
 * avoid.
 *
 * `id` is emitted only when a layer has a *durable* one — something is anchored
 * to it. A design nobody has annotated stays clean markup, exactly as a prose
 * document does not grow id comments until a block acquires a comment. That is
 * why `serializeDesign` takes the set of ids worth keeping rather than reading
 * it off the layers: the design does not know what is anchored to it.
 */

export interface SerializeOptions {
  /**
   * Layer ids that must survive into the file.
   *
   * Everything else is provisional — assigned by the parser so the canvas has
   * something to select with, and dropped on the way out.
   */
  readonly durable?: ReadonlySet<string>;
}

export function serializeDesign(design: DesignDocument, options: SerializeOptions = {}): string {
  const durable = options.durable ?? new Set<string>();
  const lines: string[] = [];

  lines.push(`<design name="${attribute(design.name)}">`);
  for (const frame of design.frames) {
    lines.push(...serializeFrame(frame, durable));
  }
  lines.push('</design>');
  return `${lines.join('\n')}\n`;
}

function serializeFrame(frame: Frame, durable: ReadonlySet<string>): string[] {
  const attrs = [
    idAttribute(frame.id, durable),
    `name="${attribute(frame.name)}"`,
    `width="${frame.width}"`,
    frame.height === 'auto' ? 'height="auto"' : `height="${frame.height}"`,
    classAttribute(frame.classes),
  ].filter(Boolean);

  const open = `  <frame ${attrs.join(' ')}>`;
  if (frame.children.length === 0) return [open, '  </frame>'];
  return [open, ...frame.children.flatMap((child) => serializeLayer(child, durable, 2)), '  </frame>'];
}

function serializeLayer(layer: Layer, durable: ReadonlySet<string>, depth: number): string[] {
  const pad = '  '.repeat(depth);
  const attrs = [idAttribute(layer.id, durable), nameAttribute(layer), classAttribute(layer.classes)].filter(Boolean);
  const head = attrs.length > 0 ? ` ${attrs.join(' ')}` : '';

  if (layer.kind === 'image') {
    return [`${pad}<image${head} src="${attribute(layer.src)}" alt="${attribute(layer.alt)}" />`];
  }
  if (layer.kind === 'text') {
    // On one line whatever its length. A wrapped string would make the diff of
    // a reworded label span several lines and, worse, would make the file's
    // whitespace part of the content.
    return [`${pad}<text${head}>${encode(layer.content)}</text>`];
  }
  if (layer.children.length === 0) return [`${pad}<box${head}></box>`];
  return [
    `${pad}<box${head}>`,
    ...layer.children.flatMap((child) => serializeLayer(child, durable, depth + 1)),
    `${pad}</box>`,
  ];
}

function idAttribute(id: string, durable: ReadonlySet<string>): string {
  return durable.has(id) ? `id="${attribute(id)}"` : '';
}

/**
 * A name is emitted only when it says something.
 *
 * The parser gives an unnamed box the name "Box", so writing that back would
 * add an attribute to every line of every design that nobody asked for.
 */
function nameAttribute(layer: Layer): string {
  const generic = layer.kind === 'text' ? 'Text' : layer.kind === 'image' ? 'Image' : ['Box', 'Group'];
  const isGeneric = Array.isArray(generic) ? generic.includes(layer.name) : layer.name === generic;
  return isGeneric ? '' : `name="${attribute(layer.name)}"`;
}

function classAttribute(classes: readonly string[]): string {
  return classes.length > 0 ? `class="${attribute(classes.join(' '))}"` : '';
}

function attribute(value: string): string {
  return encode(value).replace(/"/g, '&quot;');
}
