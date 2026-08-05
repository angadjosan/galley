import type { Block, ParsedDocument, SourceRange } from './types.js';
import { parseDocument } from './parse.js';
import { continuationPrefix, firstLinePrefix, prefixLines } from './serialize.js';
import { applyTextEdits, blankRunAfter, lineEndAt, lineStartAt, type TextEdit } from './splice.js';

/**
 * The block operation vocabulary.
 *
 * `idea.md`, hard question #3: a suggestion is a set of block-scoped ops, not a
 * replacement blob. "Rewrite this whole section" is expressed as a sequence of
 * these, so block identity flows through an agent rewrite *by construction*
 * rather than by fuzzy matching after the fact. Anchor loss becomes possible
 * only where an agent explicitly deletes a block — semantically the right place
 * to lose one.
 *
 * Every op names its target by block id, so an op set is order-independent
 * with respect to positions: nothing here uses offsets, which would be
 * invalidated by any preceding op.
 */
export type BlockOp =
  | { readonly kind: 'replace'; readonly target: string; readonly markdown: string }
  | {
      readonly kind: 'insert';
      readonly markdown: string;
      readonly after?: string;
      readonly before?: string;
    }
  | { readonly kind: 'delete'; readonly target: string }
  | { readonly kind: 'move'; readonly target: string; readonly after?: string; readonly before?: string }
  | { readonly kind: 'materialize'; readonly target: string; readonly id: string }
  | { readonly kind: 'dematerialize'; readonly target: string };

export class UnknownBlockError extends Error {
  constructor(readonly blockId: string) {
    super(`no block with id ${blockId} in this document`);
    this.name = 'UnknownBlockError';
  }
}

export class InvalidOpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOpError';
  }
}

export interface ApplyResult {
  readonly source: string;
  readonly edits: readonly TextEdit[];
}

/**
 * Turn block ops into text edits and splice them.
 *
 * Ops are resolved against the *original* document, so an op set is atomic: no
 * op sees the effect of another, and the whole set either applies or throws.
 */
export function applyBlockOps(doc: ParsedDocument, ops: readonly BlockOp[]): ApplyResult {
  const edits: TextEdit[] = [];
  for (const op of ops) edits.push(...editsFor(doc, op));
  return { source: applyTextEdits(doc.source, edits), edits };
}

/**
 * Resolve an op target.
 *
 * Normally a materialized block id. `@N` addresses the Nth block in document
 * order, which is how a block with no durable anchor yet is named — an agent
 * commenting on a paragraph for the first time has no id to cite, and minting
 * one before the comment exists would write a marker into the file for nothing.
 */
export function blockRef(index: number): string {
  return `@${index}`;
}

function requireBlock(doc: ParsedDocument, target: string): Block {
  if (target.startsWith('@')) {
    const index = Number(target.slice(1));
    const block = Number.isInteger(index) ? doc.blocks[index] : undefined;
    if (!block) throw new UnknownBlockError(target);
    return block;
  }
  const block = doc.blocks.find((b) => b.id === target);
  if (!block) throw new UnknownBlockError(target);
  return block;
}

function editsFor(doc: ParsedDocument, op: BlockOp): TextEdit[] {
  switch (op.kind) {
    case 'replace':
      return [replaceEdit(doc, requireBlock(doc, op.target), op.markdown)];
    case 'delete':
      return [deleteEdit(doc, requireBlock(doc, op.target))];
    case 'insert': {
      if (!op.after && !op.before) {
        throw new InvalidOpError('insert requires either `after` or `before`');
      }
      const anchor = requireBlock(doc, (op.after ?? op.before)!);
      return [insertEdit(doc, anchor, op.markdown, op.after ? 'after' : 'before')];
    }
    case 'move': {
      if (!op.after && !op.before) throw new InvalidOpError('move requires either `after` or `before`');
      const block = requireBlock(doc, op.target);
      const anchor = requireBlock(doc, (op.after ?? op.before)!);
      // Compare by position, not by id: an unmaterialized block's id is null,
      // and `null === null` would make every move of an unanchored block look
      // like a self-move.
      if (anchor.range.start === block.range.start) {
        throw new InvalidOpError('cannot move a block relative to itself');
      }
      const carried = dedent(doc, block);
      const removal = deleteEdit(doc, block);
      const insertion = insertEdit(doc, anchor, carried, op.after ? 'after' : 'before');
      // The destination can land inside the region being vacated — "move X
      // after Y" when X already directly follows Y. That is a no-op, not a
      // conflict, and treating it as one would make an idempotent reordering
      // fail on its second application.
      if (insertion.range.start >= removal.range.start && insertion.range.start <= removal.range.end) {
        return [];
      }
      return [removal, insertion];
    }
    case 'materialize': {
      const block = requireBlock(doc, op.target);
      return [materializeEdit(doc, block, op.id)];
    }
    case 'dematerialize': {
      const block = requireBlock(doc, op.target);
      if (!block.markerRange) return [];
      return [{ range: block.markerRange, text: '', label: `dematerialize ${block.id}` }];
    }
  }
}

/**
 * Replace a block's content, keeping the bytes before it on its first line.
 *
 * The first-line prefix — a list marker, a blockquote `> `, an indent — is
 * *outside* the block's range and therefore never rewritten. Only continuation
 * lines need the prefix applied, which is why a paragraph rewritten inside a
 * nested list still lands at the right indent without the splicer knowing
 * anything about lists.
 */
function replaceEdit(doc: ParsedDocument, block: Block, markdown: string): TextEdit {
  if (markdown.trim() === '') {
    // Replacing a block with nothing leaves its container prefix stranded — a
    // bare `- ` or `> ` with trailing whitespace. That is a delete wearing the
    // wrong name, so say so rather than producing a malformed document.
    throw new InvalidOpError(
      `replace on ${block.id ?? block.type} was given empty content; use a delete op instead`,
    );
  }
  const first = firstLinePrefix(doc.source, block.range);
  const cont = continuationPrefix(first);
  const text = prefixLines(normalizeEol(markdown, doc.style.eol), '', cont, doc.style.eol);
  return { range: block.range, text, label: `replace ${block.id ?? block.type}` };
}

/**
 * Remove a block, its id marker, and exactly one separator.
 *
 * "Exactly one" is the part that matters: removing all following blank lines
 * would silently collapse an author's deliberate spacing, and removing none
 * makes the document grow a blank line on every delete.
 */
function deleteEdit(doc: ParsedDocument, block: Block): TextEdit {
  const source = doc.source;
  // From the block's own first line — not the marker's line, which is the
  // block's *last* line — through the end of the line the marker sits on.
  const from = lineStartAt(source, block.range.start);
  let to = lineEndAt(source, Math.max(block.range.end, block.markerRange?.end ?? 0));
  const run = blankRunAfter(source, to);
  if (run.lines > 0) {
    // Consume the separator this block owned, and give back anything beyond the
    // document's normal spacing so a deliberate run of blank lines survives.
    to = run.end;
    const giveBack = Math.max(0, run.lines - doc.style.blockSpacing);
    for (let i = 0; i < giveBack; i++) to = lineStartAt(source, to - 1);
  } else if (from > 0) {
    // Last block in its container: take the preceding separator instead, so the
    // document does not end with a trailing blank line that was not there.
    let start = from;
    for (let i = 0; i < doc.style.blockSpacing && start > 0; i++) {
      const prevLineStart = lineStartAt(source, start - 1);
      if (source.slice(prevLineStart, start).trim() !== '') break;
      start = prevLineStart;
    }
    return { range: { start, end: to }, text: '', label: `delete ${block.id ?? block.type}` };
  }
  return { range: { start: from, end: to }, text: '', label: `delete ${block.id ?? block.type}` };
}

/**
 * Insert a new block next to an anchor, separated the way this document
 * separates blocks *at this point*.
 *
 * The separation is measured, not assumed. A tight list has no blank line
 * between items and a loose one does; top-level prose usually has one blank
 * line but some authors use two. Inserting with a fixed separator would
 * reformat the surroundings of every insertion, which is the failure this
 * engine exists to avoid.
 */
function insertEdit(
  doc: ParsedDocument,
  anchor: Block,
  markdown: string,
  side: 'after' | 'before',
): TextEdit {
  const eol = doc.style.eol;
  const prefix = containerPrefix(doc, anchor);
  const body = prefixLines(normalizeEol(markdown, eol), prefix, continuationPrefix(prefix), eol);
  const gap = eol.repeat(measureGap(doc, anchor, side));

  if (side === 'after') {
    const lineEnd = lineEndAt(doc.source, Math.max(anchor.range.end, anchor.markerRange?.end ?? 0));
    const at = blankRunAfter(doc.source, lineEnd).end;
    if (at >= doc.source.length) {
      // End of file: the separator has to go *before* the new block, and the
      // document's final-newline convention decides what follows it.
      return {
        range: { start: at, end: at },
        text: `${gap}${body}${doc.style.finalNewline ? eol : ''}`,
        label: 'insert',
      };
    }
    return { range: { start: at, end: at }, text: `${body}${eol}${gap}`, label: 'insert' };
  }

  const at = lineStartAt(doc.source, anchor.range.start);
  return { range: { start: at, end: at }, text: `${body}${eol}${gap}`, label: 'insert' };
}

/** Blank lines currently separating `anchor` from its neighbour on `side`. */
function measureGap(doc: ParsedDocument, anchor: Block, side: 'after' | 'before'): number {
  const source = doc.source;
  if (side === 'after') {
    const run = blankRunAfter(
      source,
      lineEndAt(source, Math.max(anchor.range.end, anchor.markerRange?.end ?? 0)),
    );
    if (run.end < source.length) return run.lines;
    // Last block: mirror the gap that precedes it instead of inventing one.
  }
  const start = lineStartAt(source, anchor.range.start);
  let cursor = start;
  let blanks = 0;
  while (cursor > 0) {
    const prevLineStart = lineStartAt(source, cursor - 1);
    if (source.slice(prevLineStart, cursor).trim() !== '') break;
    blanks++;
    cursor = prevLineStart;
  }
  return cursor === 0 && blanks === 0 ? doc.style.blockSpacing : blanks;
}

/**
 * Write a block's id into the file, as a trailing inline comment.
 *
 * Refused for blocks with no inline content. That is a real restriction and it
 * is stated rather than worked around: a durable anchor on a table, a fenced
 * code block, or a list container falls back to fuzzy re-anchoring. See the
 * marker documentation in `parse.ts` for why an own-line comment — which would
 * work for those types — is not an option.
 */
function materializeEdit(doc: ParsedDocument, block: Block, id: string): TextEdit {
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(id)) {
    throw new InvalidOpError(`block id ${JSON.stringify(id)} is not a valid marker id`);
  }
  if (block.type !== 'paragraph' && block.type !== 'heading') {
    throw new InvalidOpError(
      `cannot materialize an id on a ${block.type} block: only paragraphs and headings carry ` +
        `inline markers; this anchor stays in the sidecar and re-anchors by content`,
    );
  }
  const marker = `<!-- ^${id} -->`;
  if (block.markerRange) {
    if (block.id === id) {
      // Already carries exactly this id. Nothing to do, and rewriting it would
      // churn the file for no reason.
      return { range: block.markerRange, text: ` ${marker}`, label: `re-materialize ${id}` };
    }
    throw new InvalidOpError(
      `block ${block.id} already has an id; materializing ${id} over it would detach every ` +
        `comment anchored to ${block.id}. Remove the old id explicitly if that is what you mean.`,
    );
  }
  return {
    range: { start: block.range.end, end: block.range.end },
    text: ` ${marker}`,
    label: `materialize ${id}`,
  };
}

/**
 * The line prefix a *sibling* of this block would carry.
 *
 * For most blocks that is simply the text before them on their first line. The
 * exception is the first child of a list item, whose prefix includes the list
 * marker: a sibling paragraph there belongs under the marker, not next to it.
 */
export function containerPrefix(doc: ParsedDocument, block: Block): string {
  const first = firstLinePrefix(doc.source, block.range);
  // A list item's own prefix is the indent before its marker, which is exactly
  // what a sibling item needs.
  if (block.type === 'listItem') return first;
  // The first child of a list item sits *after* the marker; a sibling of it
  // belongs under the marker, so the marker becomes indentation.
  if (/(?:[-*+]|\d+[.)])\s+$/.test(first)) return continuationPrefix(first);
  return first;
}

/** A block's source with its container prefix stripped, ready to be re-placed. */
export function dedent(doc: ParsedDocument, block: Block): string {
  const first = firstLinePrefix(doc.source, block.range);
  const cont = continuationPrefix(first);
  const lines = block.source.split(/\r?\n/);
  return lines
    .map((line, i) => (i === 0 ? line : line.startsWith(cont) ? line.slice(cont.length) : line.trimStart()))
    .join(doc.style.eol);
}

function normalizeEol(text: string, eol: '\n' | '\r\n'): string {
  return text.replace(/\r\n|\r|\n/g, eol);
}

/**
 * Reparse after an op set. Ops resolve against the document they were built
 * for, so any subsequent op set must be built against the result of this.
 */
export function applyAndReparse(doc: ParsedDocument, ops: readonly BlockOp[]): ParsedDocument {
  const { source } = applyBlockOps(doc, ops);
  return parseDocument(source);
}

export type { SourceRange, TextEdit };
