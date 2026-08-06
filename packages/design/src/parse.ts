import { defaultFrameName, defaultLayerName } from './names.js';
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

/**
 * Decode entities, and never throw.
 *
 * `String.fromCodePoint` raises `RangeError` for anything above U+10FFFF, and
 * this function runs inside a React render *and* inside a ProseMirror
 * `decorations()` call — so one `&#1114112;` in a design took down the canvas
 * and every prose document that linked to it. A parser whose entire job is to
 * refuse rather than crash must not be the thing that crashes.
 *
 * Hex entities are accepted too. They were not, and the failure was quiet in
 * the worst way: `&#x27;` matched nothing, so no error was raised *and* the
 * literal text survived to be escaped into `&amp;#x27;` on the way out — a
 * round trip that changed what a label said.
 */
function decode(value: string, line: number, errors: ParseError[]): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity.startsWith('#')) {
      const point = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      // Surrogates are excluded as well as out-of-range values: a lone
      // surrogate is a legal code point and an illegal character, and letting
      // one through produces a string that cannot be serialized.
      if (!Number.isInteger(point) || point < 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) {
        errors.push({ line, message: `\`${whole}\` is not a character.` });
        return whole;
      }
      return String.fromCodePoint(point);
    }
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

/**
 * Where a tag ends, respecting quoted attribute values.
 *
 * `indexOf('>')` is wrong and wrong *silently*: `<text name="a>b">hi</text>`
 * ended the tag inside the quotes, so the name was destroyed, the leftover
 * `b">hi` became the element's content, and the parse reported success. Silent
 * corruption is the one outcome this format is built to make impossible.
 */
function tagEnd(source: string, from: number): number {
  let quoted = false;
  for (let i = from + 1; i < source.length; i++) {
    const character = source[i];
    if (character === '"') quoted = !quoted;
    else if (character === '>' && !quoted) return i;
    // An unterminated quote cannot run past the line the tag started on —
    // otherwise one missing `"` swallows the rest of the document.
    else if (character === '\n' && quoted) return -1;
  }
  return -1;
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

    const end = tagEnd(source, index);
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
    const rest = body.trim().slice(nameMatch[1]!.length);
    // Consume the attribute list token by token rather than scanning for the
    // ones that look right. Skipping what does not match is how `class=flex`
    // lost a layer's entire styling with no error at all.
    const attributePattern = /\s*([a-z-]+)(\s*=\s*(?:"([^"]*)"|([^\s"'>]+))?)?/giy;
    attributePattern.lastIndex = 0;
    let consumed = 0;
    let match: RegExpExecArray | null;
    while ((match = attributePattern.exec(rest)) !== null) {
      consumed = attributePattern.lastIndex;
      const key = match[1]!.toLowerCase();
      if (match[3] === undefined) {
        errors.push({
          line: startLine,
          message:
            match[4] !== undefined
              ? `\`${key}\` needs quotes around its value: \`${key}="${match[4]}"\`.`
              : `\`${key}\` has no value.`,
        });
        continue;
      }
      if (key in attrs) {
        errors.push({ line: startLine, message: `\`${key}\` is given twice on one \`<${name}>\`.` });
        continue;
      }
      attrs[key] = decode(match[3], startLine, errors);
    }
    if (consumed < rest.trimEnd().length) {
      errors.push({ line: startLine, message: `\`${rest.slice(consumed).trim()}\` is not an attribute.` });
    }
    tokens.push({ kind: 'open', name, attrs, text: '', line: startLine, selfClosing });
    advance(end + 1);
  }
  return tokens;
}

function splitClasses(value: string | undefined): string[] {
  return (value ?? '').split(/\s+/).filter(Boolean);
}

/**
 * The id a layer gets when the file does not give it one.
 *
 * **Derived from where the layer sits, never from a counter.** A counter is
 * stable within one parse and useless across two, and the canvas re-parses on
 * every edit — so a monotonic id meant the selected layer's id changed the
 * instant anything was typed, and the selection died on every keystroke. It
 * also meant two parses of the same bytes disagreed about what a layer was
 * called, which is not a property an identifier may have.
 *
 * A position-derived id is stable for as long as the layer stays where it is,
 * which is exactly the guarantee a *provisional* id should make. The moment a
 * layer needs to survive being moved, it has earned a durable id in the file.
 */
function provisional(path: readonly number[]): LayerId {
  return `l_${path.join('_')}`;
}

export function parseDesign(source: string): ParseResult {
  const errors: ParseError[] = [];
  const tokens = tokenize(source, errors);

  let name = 'Untitled design';
  const frames: Frame[] = [];

  // An explicit stack rather than recursion: the error messages need to name
  // the element that was left open, and a recursive descent loses that.
  const stack: { name: string; line: number; attrs: Record<string, string>; children: Layer[] }[] = [];

  /** Where the element being closed sits, as a path of child indexes. */
  const pathOf = (): number[] => {
    const path: number[] = [];
    for (let depth = 1; depth < stack.length; depth++) path.push(stack[depth]!.children.length);
    return path;
  };

  const finishLayer = (
    frame: { name: string; attrs: Record<string, string>; children: Layer[]; line: number },
    path: readonly number[],
  ): Layer | null => {
    const attrs = frame.attrs;
    const base = {
      id: attrs.id || provisional(path),
      name: attrs.name || defaultLayerName(frame.name as 'box' | 'text' | 'image', frame.children.length),
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
      const enclosing = stack[stack.length - 1];

      // Three nestings the grammar does not have. Each one used to be accepted
      // and quietly flattened — a nested frame was hoisted to the top level and
      // emitted *first*, so frames reordered on save.
      if (token.name === 'design' && enclosing) {
        errors.push({ line: token.line, message: '`<design>` cannot contain another `<design>`.' });
        continue;
      }
      if (token.name === 'frame' && enclosing && enclosing.name !== 'design') {
        errors.push({ line: token.line, message: `A \`<frame>\` cannot go inside \`<${enclosing.name}>\`.` });
        continue;
      }
      if (enclosing?.name === 'text') {
        errors.push({
          line: token.line,
          message: `\`<text>\` holds words, not a \`<${token.name}>\`. Put them side by side in a \`<box>\`.`,
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
        const layer = finishLayer(entry, [frames.length, ...pathOf()]);
        const parent = stack[stack.length - 1];
        if (layer && parent) parent.children.push(layer);
        else if (layer) errors.push({ line: token.line, message: 'A layer outside any frame.' });
        continue;
      }
      stack.push(entry);
      continue;
    }

    // close
    // `<image>` never has children, so it is completed the moment it opens and
    // never reaches the stack. A written-out `</image>` would therefore pop its
    // *parent*, and the resulting cascade reported four errors, none of which
    // named the actual mistake.
    if (token.name === 'image') continue;

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
      const height = rawHeight === 'auto' ? 'auto' : Number(rawHeight);
      // Checked the same way `width` is. It was not, so `height="tall"` became
      // `NaN`, was written back to the file as `height="NaN"`, and reached the
      // renderer as a style nobody could see was wrong.
      if (height !== 'auto' && (!Number.isFinite(height) || height <= 0)) {
        errors.push({ line: top.line, message: '`height` must be a number of pixels, or `auto`.' });
        continue;
      }
      frames.push({
        id: top.attrs.id || provisional([frames.length]),
        name: top.attrs.name || defaultFrameName(frames.length),
        width,
        height,
        classes: splitClasses(top.attrs.class),
        children: top.children,
      });
      continue;
    }
    const layer = finishLayer(top, [frames.length, ...pathOf()]);
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
