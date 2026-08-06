/**
 * How a design lives in a workspace, and how a document points at one.
 *
 * A design is **its own Galley document**, not a block inside a prose one. That
 * is the decision worth defending, because putting it inline is the obvious
 * shortcut:
 *
 * - Inline, every canvas nudge lands in the prose document's diff and its
 *   timeline. A spec's history should read as a record of what the spec said,
 *   not of someone dragging a button four pixels.
 * - Inline, a design has no identity of its own, so it cannot be cited from a
 *   second document, cannot be commented on independently, and cannot be
 *   suggested against without suggesting against the prose around it.
 * - Inline, two documents cannot share one design, which is most of what a
 *   design reference is *for*.
 *
 * So: a design is a document whose body is a single fenced block with the info
 * string `design`. It gets a `galley:` id, a history, comments, suggestions and
 * a CLI read path by construction, because it is a document and all of that
 * already works for documents. Nothing in the storage layer had to learn a new
 * kind of file — which is also the honest reason this differs from the research
 * recommendation of a `.design.html` sibling: a second storage type is a large
 * change to justify for a difference the reader never sees.
 *
 * It degrades correctly. Opened anywhere else, a design document renders as a
 * fenced code block showing its own markup — legible, complete, and obviously
 * not prose. Nothing is lost and nothing is misrepresented.
 *
 * A prose document points at one with an ordinary CommonMark link:
 *
 *     [Checkout — payment step](designs/checkout-payment)
 *
 * which is a link everywhere else and a live, selectable, commentable embed in
 * Galley. Principle IV holds with nothing to degrade, because nothing was
 * extended.
 */
import { parseDesign, type ParseError } from './parse.js';
import type { DesignDocument } from './types.js';

/** The info string that makes a fenced block a design. */
export const DESIGN_FENCE = 'design';

/**
 * The design fence.
 *
 * The info string must be **exactly** `design`. It was a prefix match, and the
 * consequences were not cosmetic: a ```designer or ```designsystem fence made
 * an ordinary prose document open as a design — unreachable in the prose
 * editor, drawn as an empty broken canvas — and the next save rewrote the info
 * string to `design`, destroying the author's language tag.
 *
 * **Column zero only**, though CommonMark allows up to three spaces of indent.
 * An indented fence is indented on every line, so writing a design back into
 * one would have to re-indent the markup — and the markup is what the diff is
 * measured in. Matching it and then failing to round-trip it is worse than not
 * matching it: a design inside a list item is simply not a design, and it says
 * so by opening as prose.
 *
 * What this deliberately does *not* do is track enclosing fences, so a ```design
 * block quoted inside a ````four-backtick block is still found. Doing that
 * properly means parsing the document, and `extractDesign` runs against every
 * document that is opened. The partial mitigation is that the closing delimiter
 * must match the opening one.
 */
const FENCE = /(^|\n)(`{3,}|~{3,})[ \t]*design[ \t]*(?=\n)\n([\s\S]*?)\n?\2[ \t]*(?=\n|$)/;

/**
 * Pull the design out of a document's Markdown.
 *
 * Returns null for a document that is not a design, which is the common case
 * and must be cheap: every link in every document is checked against this.
 */
export function extractDesign(
  markdown: string,
): { source: string; design: DesignDocument; errors: readonly ParseError[] } | null {
  const match = FENCE.exec(markdown);
  if (!match) return null;
  const source = match[3] ?? '';
  const parsed = parseDesign(source);
  // A design that does not parse is still a design — the canvas shows the
  // errors rather than pretending the document is prose. The errors come back
  // with it, because swallowing them meant `galley design outline` printed
  // "Untitled design" and exited 0 for a file it could not read: the tool lied,
  // and the entire value of a strict parser was unreachable from the CLI.
  return {
    source,
    design: parsed.ok ? parsed.design : { name: 'Untitled design', frames: [] },
    errors: parsed.ok ? [] : parsed.errors,
  };
}

/** Whether a document is a design, without paying to parse it. */
export function isDesignDocument(markdown: string): boolean {
  return FENCE.test(markdown);
}

/**
 * Put a design back into its document, leaving everything around it alone.
 *
 * The same splicing rule the prose engine follows: the fence's *contents* are
 * replaced and every other byte — frontmatter, a title above it, notes below —
 * is copied. A design document is allowed to have prose in it, and editing the
 * canvas must not reformat that prose.
 */
export function embedDesign(markdown: string, source: string): string {
  const match = FENCE.exec(markdown);
  const body = source.replace(/\n+$/, '');
  if (!match) {
    const separator = markdown.length === 0 || markdown.endsWith('\n\n') ? '' : markdown.endsWith('\n') ? '\n' : '\n\n';
    return `${markdown}${separator}\`\`\`${DESIGN_FENCE}\n${body}\n\`\`\`\n`;
  }
  const start = match.index + (match[1]?.length ?? 0);
  const fence = match[2]!;
  const end = start + match[0].length - (match[1]?.length ?? 0);
  const replacement = `${fence}${DESIGN_FENCE}\n${body}\n${fence}`;
  return markdown.slice(0, start) + replacement + markdown.slice(end);
}
