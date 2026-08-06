import type { DesignDocument, Frame, ImageLayer, Layer, LayerId } from './types.js';

/**
 * Reading a design.
 *
 * A hand-written parser rather than `DOMParser`, for two reasons that are not
 * about performance. It has to run in Node — the CLI reads designs, and the
 * linter runs in CI — and it has to be *strict*: a browser parser is
 * specified to recover from anything, which is exactly wrong for a format whose
 * value is that an unknown construct is reported rather than silently dropped.
 *
 * The grammar is deliberately tiny. Four element names, five attributes, no
 * self-closing forms except `<image>`, no entities beyond the five XML ones, no
 * comments, no processing instructions. Anything else is an error naming the
 * line it is on.
 */

export interface ParseError {
  readonly line: number;
  readonly message: string;
}

export type ParseResult =
  | { readonly ok: true; readonly design: DesignDocument }
  | { readonly ok: false; readonly errors: readonly ParseError[] };

interface Token {
  readonly kind: 'open' | 'close' | 'text';
  readonly name: string;
  readonly attrs: Record<string, string>;
  readonly text: string;
  readonly line: number;
  readonly selfClosing: boolean;
}

const ELEMENTS = new Set(['design', 'frame', 'box', 'text', 'image']);

/** The five XML entities, and nothing else — an unknown one is an error. */
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decode(value: string, line: number, errors: ParseError[]): string {
  return value.replace(/&([a-z]+|#\d+);/gi, (whole, entity: string) => {
    if (entity.startsWith('#')) return String.fromCodePoint(Number(entity.slice(1)));
    const decoded = ENTITIES[entity.toLowerCase()];
    if (decoded === undefined) {
      errors.push({ line, message: `\`${whole}\` is not an entity this format knows.` });
      return whole;
    }
    return decoded;
  });
}

export function encode(value: string): string {
  return value.replace(/[&<>]/g, (character) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt' }[character]};`);
}

function encodeAttribute(value: string): string {
  return encode(value).replace(/"/g, '&quot;');
}

function tokenize(source: string, errors: ParseError[]): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;

  const advance = (to: number): void => {
    for (let i = index; i < to; i++) if (source[i] === '\n') line++;
    index = to;
  };

  while (index < source.length) {
    const next = source.indexOf('<', index);
    if (next === -1) {
      const text = source.slice(index);
      if (text.trim()) tokens.push({ kind: 'text', name: '', attrs: {}, text: decode(text, line, errors), line, selfClosing: false });
      break;
    }
    if (next > index) {
      const text = source.slice(index, next);
      if (text.trim()) {
        tokens.push({ kind: 'text', name: '', attrs: {}, text: decode(text, line, errors), line, selfClosing: false });
      }
      advance(next);
    }

    const end = source.indexOf('>', index);
    if (end === -1) {
      errors.push({ line, message: 'A tag was opened and never closed.' });
      break;
    }
    const raw = source.slice(index + 1, end);
    const startLine = line;

    if (raw.startsWith('/')) {
      tokens.push({ kind: 'close', name: raw.slice(1).trim().toLowerCase(), attrs: {}, text: '', line: startLine, selfClosing: false });
      advance(end + 1);
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameMatch = /^([a-z]+)/i.exec(body.trim());
    if (!nameMatch) {
      errors.push({ line: startLine, message: 'A tag with no element name.' });
      advance(end + 1);
      continue;
    }
    const name = nameMatch[1]!.toLowerCase();
    const attrs: Record<string, string> = {};
    const attributePattern = /([a-z-]+)\s*=\s*"([^"]*)"/gi;
    let match: RegExpExecArray | null;
    const rest = body.trim().slice(nameMatch[1]!.length);
    while ((match = attributePattern.exec(rest)) !== null) {
      attrs[match[1]!.toLowerCase()] = decode(match[2]!, startLine, errors);
    }
    tokens.push({ kind: 'open', name, attrs, text: '', line: startLine, selfClosing });
    advance(end + 1);
  }
  return tokens;
}

function splitClasses(value: string | undefined): string[] {
  return (value ?? '').split(/\s+/).filter(Boolean);
}

let counter = 0;
/** An id for a layer that has none yet. Stable within one parse. */
function provisional(): LayerId {
  return `l_${(++counter).toString(36).padStart(4, '0')}`;
}

export function parseDesign(source: string): ParseResult {
  const errors: ParseError[] = [];
  const tokens = tokenize(source, errors);

  let name = 'Untitled design';
  const frames: Frame[] = [];

  // An explicit stack rather than recursion: the error messages need to name
  // the element that was left open, and a recursive descent loses that.
  const stack: { name: string; line: number; attrs: Record<string, string>; children: Layer[] }[] = [];

  const finishLayer = (frame: { name: string; attrs: Record<string, string>; children: Layer[]; line: number }): Layer | null => {
    const attrs = frame.attrs;
    const base = {
      id: attrs.id || provisional(),
      name: attrs.name || defaultName(frame.name, frame.children.length),
      classes: splitClasses(attrs.class),
    };
    if (frame.name === 'box') return { ...base, kind: 'box', children: frame.children };
    if (frame.name === 'text') {
      return { ...base, kind: 'text', content: frame.children.length === 0 ? (attrs['#text'] ?? '') : '' };
    }
    if (frame.name === 'image') {
      if (!attrs.src) {
        errors.push({ line: frame.line, message: 'An image needs a `src`.' });
        return null;
      }
      return { ...base, kind: 'image', src: attrs.src, alt: attrs.alt ?? '' } satisfies ImageLayer;
    }
    return null;
  };

  for (const token of tokens) {
    if (token.kind === 'text') {
      const top = stack[stack.length - 1];
      if (!top) continue;
      if (top.name !== 'text') {
        errors.push({
          line: token.line,
          message: `Loose text inside \`<${top.name}>\`. Words belong in a \`<text>\` element.`,
        });
        continue;
      }
      top.attrs['#text'] = (top.attrs['#text'] ?? '') + token.text;
      continue;
    }

    if (token.kind === 'open') {
      if (!ELEMENTS.has(token.name)) {
        errors.push({
          line: token.line,
          message: `\`<${token.name}>\` is not an element this format has. The elements are ${[...ELEMENTS].map((e) => `\`<${e}>\``).join(', ')}.`,
        });
        continue;
      }
      if (token.name === 'design') {
        name = token.attrs.name || name;
        stack.push({ name: 'design', line: token.line, attrs: token.attrs, children: [] });
        continue;
      }
      const entry = { name: token.name, line: token.line, attrs: token.attrs, children: [] as Layer[] };
      if (token.selfClosing || token.name === 'image') {
        // `<image>` never has children, so it closes itself whether or not the
        // author wrote the slash.
        const layer = finishLayer(entry);
        const parent = stack[stack.length - 1];
        if (layer && parent) parent.children.push(layer);
        else if (layer) errors.push({ line: token.line, message: 'A layer outside any frame.' });
        continue;
      }
      stack.push(entry);
      continue;
    }

    // close
    const top = stack.pop();
    if (!top) {
      errors.push({ line: token.line, message: `\`</${token.name}>\` closes nothing.` });
      continue;
    }
    if (top.name !== token.name) {
      errors.push({
        line: token.line,
        message: `\`</${token.name}>\` closes \`<${top.name}>\`, opened on line ${top.line}.`,
      });
    }
    if (top.name === 'design') continue;
    if (top.name === 'frame') {
      const width = Number(top.attrs.width ?? 0);
      if (!Number.isFinite(width) || width <= 0) {
        errors.push({ line: top.line, message: 'A frame needs a `width` in pixels.' });
        continue;
      }
      const rawHeight = top.attrs.height ?? 'auto';
      frames.push({
        id: top.attrs.id || provisional(),
        name: top.attrs.name || `Frame ${frames.length + 1}`,
        width,
        height: rawHeight === 'auto' ? 'auto' : Number(rawHeight),
        classes: splitClasses(top.attrs.class),
        children: top.children,
      });
      continue;
    }
    const layer = finishLayer(top);
    const parent = stack[stack.length - 1];
    if (!layer) continue;
    if (!parent || parent.name === 'design') {
      errors.push({ line: top.line, message: 'A layer outside any frame. Wrap it in a `<frame>`.' });
      continue;
    }
    parent.children.push(layer);
  }

  for (const unclosed of stack) {
    errors.push({ line: unclosed.line, message: `\`<${unclosed.name}>\` was never closed.` });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, design: { name, frames } };
}

function defaultName(element: string, childCount: number): string {
  if (element === 'text') return 'Text';
  if (element === 'image') return 'Image';
  return childCount > 0 ? 'Group' : 'Box';
}
