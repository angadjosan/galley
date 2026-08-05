import type { PhrasingContent } from 'mdast';
import type { StyleProfile } from './types.js';

/**
 * Characters that can start inline markup and therefore need escaping when they
 * appear in literal text. `_` is handled separately because intraword
 * underscores do not create emphasis in CommonMark, and escaping every one of
 * them turns `snake_case_names` into unreadable noise for no benefit.
 */
const ALWAYS_ESCAPE = /[\\`*[\]<>~|]/g;

/** Characters that only mean something at the start of a line. */
const LINE_START_ESCAPE = /^(\s*)([#>+\-=]|(\d+)([.)]))/;

/**
 * Escape literal text so it survives a round trip through the parser.
 *
 * The bar is exact: `parse(serialize(text)) === text`. Over-escaping is ugly;
 * under-escaping silently changes a user's document, so where the two conflict
 * this errs toward escaping.
 */
export function escapeText(value: string, atLineStart = true): string {
  let escaped = value.replace(ALWAYS_ESCAPE, (ch) => `\\${ch}`);
  // Underscores only need escaping at a word boundary, where they could open or
  // close emphasis.
  escaped = escaped.replace(/(^|[^\w\\])_|_(?=[^\w]|$)/g, (match) => {
    const idx = match.indexOf('_');
    return `${match.slice(0, idx)}\\_${match.slice(idx + 1)}`;
  });
  // Only when this text really is at the start of a line. Applying it to every
  // text node turns `**1. The first phase.**` into `**\1. The first phase.**`,
  // and a backslash before a digit is not an escape — the reader just sees it.
  // It fires on this repo's own design docs.
  if (atLineStart) {
    escaped = escaped.replace(
      LINE_START_ESCAPE,
      (_m, ws: string, marker: string, digits: string | undefined, delimiter: string | undefined) =>
        // For an ordered-list marker the backslash goes before the *delimiter*:
        // `1\.`, not `\1.`. A backslash before a digit is not an escape in
        // CommonMark, so the escape did not work *and* the reader saw the
        // backslash — and the next pass escaped that backslash, so the document
        // grew one per save.
        digits !== undefined ? `${ws}${digits}\\${delimiter}` : `${ws}\\${marker}`,
    );
  }
  return escaped;
}

/** Pick a backtick run long enough to fence the given code text. */
function codeFenceFor(value: string): string {
  const runs = value.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(longest + 1);
}

/**
 * Serialize inline content back to Markdown in the document's own style.
 *
 * Used only for content the editor actually changed. Unchanged blocks are
 * re-emitted from their original bytes and never pass through here — which is
 * why a serializer that is merely *good* is sufficient, rather than one that
 * has to be byte-perfect against every author's habits.
 */
export function serializeInline(
  nodes: readonly PhrasingContent[],
  style: StyleProfile,
  atLineStart = true,
): string {
  // Only a node that actually begins a line can need a line-start escape.
  // That is the first node of a *block*, or the first after a hard break —
  // never the first child of emphasis, a link, or a heading's `# `, because
  // those all put characters in front of it. Passing `index === 0` regardless
  // of context turned `**1. The first phase.**` into `**\1. The first phase.**`,
  // and a backslash before a digit is not an escape in CommonMark, so the
  // reader simply saw the backslash. It fired on this repo's own design docs.
  let lineStart = atLineStart;
  const parts: string[] = [];
  for (const node of nodes) {
    parts.push(serializeNode(node, style, lineStart));
    lineStart = node.type === 'break';
  }
  return parts.join('');
}

function serializeNode(node: PhrasingContent, style: StyleProfile, atLineStart = false): string {
  switch (node.type) {
    case 'text':
      return escapeText(node.value, atLineStart);
    case 'emphasis':
      return `${style.emphasis}${serializeInline(node.children, style, false)}${style.emphasis}`;
    case 'strong':
      return `${style.strong}${serializeInline(node.children, style, false)}${style.strong}`;
    case 'delete':
      return `~~${serializeInline(node.children, style, false)}~~`;
    case 'inlineCode': {
      const fence = codeFenceFor(node.value);
      // A value that starts or ends with a backtick needs padding spaces, which
      // CommonMark strips on parse.
      const pad = node.value.startsWith('`') || node.value.endsWith('`') ? ' ' : '';
      return `${fence}${pad}${node.value}${pad}${fence}`;
    }
    case 'link': {
      const title = node.title ? ` "${node.title.replace(/"/g, '\\"')}"` : '';
      return `[${serializeInline(node.children, style, false)}](${encodeUrl(node.url)}${title})`;
    }
    case 'image': {
      const title = node.title ? ` "${node.title.replace(/"/g, '\\"')}"` : '';
      return `![${escapeText(node.alt ?? '')}](${encodeUrl(node.url)}${title})`;
    }
    case 'linkReference':
      return `[${serializeInline(node.children, style, false)}][${node.identifier}]`;
    case 'imageReference':
      return `![${escapeText(node.alt ?? '')}][${node.identifier}]`;
    case 'break':
      return style.hardBreak === 'backslash' ? `\\${style.eol}` : `  ${style.eol}`;
    case 'html':
      return node.value;
    case 'footnoteReference':
      return `[^${node.identifier}]`;
    default: {
      // Unknown phrasing node: fall back to its text rather than dropping it.
      const anyNode = node as { children?: PhrasingContent[]; value?: string };
      if (anyNode.children) return serializeInline(anyNode.children, style, atLineStart);
      return anyNode.value ?? '';
    }
  }
}

/** Percent-encode only what would break the link syntax. */
function encodeUrl(url: string): string {
  if (/[\s()<>]/.test(url)) {
    return `<${url.replace(/([<>])/g, '\\$1')}>`;
  }
  return url;
}
