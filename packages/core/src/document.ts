import { LoroDoc, LoroMap, LoroText, VersionVector, type LoroMovableList } from 'loro-crdt';
import { blockId, ulid } from '@galley/anchor';
import {
  applyBlockOps,
  parseDocument,
  setFrontmatterKeys,
  type BlockOp,
  type ParsedDocument,
} from '@galley/markdown';
import { assemble, segment, type Segment, type SegmentedDocument } from './segments.js';
import { minimalSplice, reconcile, type ReconcileStep } from './reconcile.js';

const SEGMENTS = 'segments';
const PREAMBLE = 'preamble';
const META = 'meta';

export interface CreateOptions {
  /** Document identity. Generated if absent, and written into frontmatter. */
  docId?: string;
  /** CRDT peer identity. Distinct per client, per session. */
  peerId?: bigint;
  title?: string;
  owner?: string;
}

export interface ApplyResult {
  readonly source: string;
  readonly steps: readonly ReconcileStep[];
}

/**
 * A document, as the CRDT holds it.
 *
 * The structure is deliberately shallow:
 *
 * ```
 * LoroDoc
 *   ├ meta      LoroMap    galley id, title, owner
 *   ├ preamble  LoroText   frontmatter and leading whitespace, verbatim
 *   └ segments  LoroMovableList of LoroMap { sid, text: LoroText, sep }
 * ```
 *
 * `toMarkdown()` is `preamble + Σ(text + separator)`, which is byte-exact by
 * construction rather than by care — there is no serializer in the path at all.
 *
 * The choice of a *movable* list is what makes "move this section above that
 * one" a first-class operation instead of a delete followed by an insert. The
 * difference is visible to users: a delete-and-insert loses the section's
 * identity, and with it every comment anchored inside it.
 *
 * Concurrency is Loro's job at the character level within a segment, and the
 * server's `Sequencer` at the operation level — see `@galley/concurrency`. The
 * two are not redundant: the CRDT guarantees convergence, the sequencer
 * guarantees a *defined order*, which is what attribution, staleness and the
 * session boundary all need.
 */
export class GalleyDocument {
  private constructor(readonly loro: LoroDoc) {}

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  /** Build a new document from Markdown, minting ids for every segment. */
  static create(source: string, options: CreateOptions = {}): GalleyDocument {
    const loro = new LoroDoc();
    if (options.peerId !== undefined) loro.setPeerId(options.peerId);

    // The `galley:` frontmatter key is the identity that survives a rename, a
    // move, and a copy — so a document that already carries one keeps it. Only
    // a document with no identity gets a fresh ULID, and it is written on
    // creation rather than lazily, so a file pulled to disk is already
    // identified when an agent finds it.
    const existing = parseDocument(source).frontmatter?.data.galley;
    const docId =
      options.docId ?? (typeof existing === 'string' && existing.length > 0 ? existing : ulid());
    const withIdentity = ensureIdentity(source, docId, options.owner);

    const doc = new GalleyDocument(loro);
    const meta = loro.getMap(META);
    meta.set('galleyId', docId);
    if (options.title) meta.set('title', options.title);
    if (options.owner) meta.set('owner', options.owner);
    meta.set('createdAt', new Date().toISOString());

    doc.writeSegmented(segment(withIdentity, () => blockId()));
    loro.commit();
    return doc;
  }

  /** Reopen a document from a Loro snapshot. */
  static open(snapshot: Uint8Array, peerId?: bigint): GalleyDocument {
    const loro = new LoroDoc();
    loro.import(snapshot);
    if (peerId !== undefined) loro.setPeerId(peerId);
    return new GalleyDocument(loro);
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  get docId(): string {
    return (this.loro.getMap(META).get('galleyId') as string | undefined) ?? '';
  }

  get title(): string | undefined {
    return this.loro.getMap(META).get('title') as string | undefined;
  }

  get owner(): string | undefined {
    return this.loro.getMap(META).get('owner') as string | undefined;
  }

  setMeta(key: string, value: string): void {
    this.loro.getMap(META).set(key, value);
    this.loro.commit();
  }

  /** The document's exact bytes. */
  toMarkdown(): string {
    return assemble(this.segmented());
  }

  segmented(): SegmentedDocument {
    const list = this.segmentList();
    const segments: Segment[] = [];
    for (let i = 0; i < list.length; i++) {
      const map = list.get(i) as LoroMap;
      segments.push({
        sid: map.get('sid') as string,
        text: (map.get('text') as LoroText).toString(),
        separator: (map.get('sep') as string | undefined) ?? '',
      });
    }
    return { preamble: this.loro.getText(PREAMBLE).toString(), segments };
  }

  /** Parse the current bytes. Callers that need blocks use this, not the CRDT. */
  parsed(): ParsedDocument {
    return parseDocument(this.toMarkdown());
  }

  /** Index of the segment containing a given block id, or -1. */
  segmentOfBlock(id: string): number {
    const segments = this.segmented().segments;
    for (let i = 0; i < segments.length; i++) {
      const parsed = parseDocument(segments[i]!.text, { noFrontmatter: true });
      if (parsed.blocks.some((b) => b.id === id)) return i;
    }
    return -1;
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  /**
   * Apply block ops and reconcile the result into the CRDT.
   *
   * The ops are resolved against the current bytes by the splicing engine, so
   * every guarantee that engine makes — byte stability, measured spacing,
   * refusal of overlapping edits — holds here unchanged. This method's only job
   * is to land the result in the CRDT at the right granularity.
   */
  applyOps(ops: readonly BlockOp[]): ApplyResult {
    const parsed = this.parsed();
    const { source } = applyBlockOps(parsed, ops);
    return this.setMarkdown(source);
  }

  /**
   * Replace the document's bytes, preserving identity wherever possible.
   *
   * The reconciliation is the important part: an untouched segment is left
   * completely alone, an edited one is spliced at the character level so a
   * concurrent edit elsewhere in the same paragraph still merges, and only a
   * genuinely new or removed block becomes a list insert or delete.
   */
  setMarkdown(next: string): ApplyResult {
    const before = this.segmented();
    if (assemble(before) === next) return { source: next, steps: [] };

    const after = segment(next, () => '');
    const steps = reconcile(before.segments, after.segments);
    const list = this.segmentList();

    // Preamble first: frontmatter changes are independent of the body.
    const preamble = this.loro.getText(PREAMBLE);
    const preambleSplice = minimalSplice(preamble.toString(), after.preamble);
    if (preambleSplice) {
      preamble.delete(preambleSplice.index, preambleSplice.deleteCount);
      if (preambleSplice.insert) preamble.insert(preambleSplice.index, preambleSplice.insert);
    }

    // Deletes descend by original index so earlier indices stay valid.
    const deletes = steps
      .filter((s): s is Extract<ReconcileStep, { kind: 'delete' }> => s.kind === 'delete')
      .sort((a, b) => b.from - a.from);
    for (const step of deletes) list.delete(step.from, 1);

    // Updates and keeps, addressed by sid so the deletes above cannot shift them.
    for (const step of steps) {
      if (step.kind !== 'update') continue;
      const index = this.indexOfSid(list, step.sid);
      if (index < 0) continue;
      const map = list.get(index) as LoroMap;
      const text = map.get('text') as LoroText;
      const splice = minimalSplice(text.toString(), step.text);
      if (splice) {
        text.delete(splice.index, splice.deleteCount);
        if (splice.insert) text.insert(splice.index, splice.insert);
      }
      if ((map.get('sep') as string | undefined) !== step.separator) map.set('sep', step.separator);
    }

    // Inserts ascend by target index so each lands in the right place.
    const inserts = steps
      .filter((s): s is Extract<ReconcileStep, { kind: 'insert' }> => s.kind === 'insert')
      .sort((a, b) => a.at - b.at);
    for (const step of inserts) {
      const at = Math.min(step.at, list.length);
      this.insertSegment(list, at, blockId(), step.text, step.separator);
    }

    // Finally, reorder to the target sequence. Moves are a distinct operation
    // in a movable list: a section that moved keeps its identity, and so does
    // every comment anchored inside it.
    this.reorderTo(
      list,
      steps
        .filter((s) => s.kind === 'keep' || s.kind === 'update')
        .sort((a, b) => (a as { to: number }).to - (b as { to: number }).to)
        .map((s) => (s as { sid: string }).sid),
      steps,
    );

    // Separators on kept segments can still change even when their text did not
    // — inserting a section changes what precedes it.
    for (const step of steps) {
      if (step.kind !== 'keep') continue;
      const index = this.indexOfSid(list, step.sid);
      if (index < 0) continue;
      const map = list.get(index) as LoroMap;
      const target = after.segments[step.to]!;
      if ((map.get('sep') as string | undefined) !== target.separator) map.set('sep', target.separator);
    }

    this.loro.commit();
    return { source: this.toMarkdown(), steps };
  }

  /** Set or update frontmatter keys, preserving the rest of the block. */
  setFrontmatter(entries: Readonly<Record<string, unknown>>): ApplyResult {
    return this.setMarkdown(setFrontmatterKeys(this.parsed(), entries));
  }

  // -------------------------------------------------------------------------
  // Sync
  // -------------------------------------------------------------------------

  /** A full snapshot, for storage and for a client's first load. */
  snapshot(): Uint8Array {
    return this.loro.export({ mode: 'snapshot' });
  }

  /**
   * Only the operations this document has that the given peer does not.
   *
   * Sending a full snapshot on every change would work and would be wrong: a
   * document under active editing produces a change per keystroke, and the
   * delta for one is tens of bytes against a snapshot of tens of kilobytes.
   */
  updatesSince(version?: Uint8Array): Uint8Array {
    if (!version) return this.loro.export({ mode: 'update' });
    return this.loro.export({ mode: 'update', from: VersionVector.decode(version) });
  }

  /** Apply remote operations. Returns whether anything changed. */
  importUpdates(update: Uint8Array): boolean {
    const before = this.loro.version().encode();
    this.loro.import(update);
    const after = this.loro.version().encode();
    return !equalBytes(before, after);
  }

  versionVector(): Uint8Array {
    return this.loro.version().encode();
  }

  subscribe(handler: () => void): () => void {
    return this.loro.subscribe(() => handler());
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private segmentList(): LoroMovableList {
    return this.loro.getMovableList(SEGMENTS);
  }

  private writeSegmented(doc: SegmentedDocument): void {
    this.loro.getText(PREAMBLE).insert(0, doc.preamble);
    const list = this.segmentList();
    doc.segments.forEach((s, i) => this.insertSegment(list, i, s.sid, s.text, s.separator));
  }

  private insertSegment(
    list: LoroMovableList,
    at: number,
    sid: string,
    text: string,
    separator: string,
  ): void {
    const map = list.insertContainer(at, new LoroMap());
    map.set('sid', sid);
    map.set('sep', separator);
    const container = map.setContainer('text', new LoroText());
    if (text) container.insert(0, text);
  }

  private indexOfSid(list: LoroMovableList, sid: string): number {
    for (let i = 0; i < list.length; i++) {
      if ((list.get(i) as LoroMap).get('sid') === sid) return i;
    }
    return -1;
  }

  /**
   * Move surviving segments into their target order.
   *
   * Selection-sort rather than anything cleverer: the list is top-level blocks,
   * reorderings are rare and small, and a move-based algorithm has to re-read
   * positions after every move anyway because each one shifts the others.
   */
  private reorderTo(list: LoroMovableList, orderedSids: readonly string[], steps: readonly ReconcileStep[]): void {
    const targets = new Map<string, number>();
    for (const step of steps) {
      if (step.kind === 'keep' || step.kind === 'update') targets.set(step.sid, step.to);
      if (step.kind === 'insert') continue;
    }
    if (orderedSids.length === 0) return;

    const desired = [...orderedSids];
    for (let position = 0; position < desired.length; position++) {
      const sid = desired[position]!;
      const target = targets.get(sid);
      if (target === undefined) continue;
      const current = this.indexOfSid(list, sid);
      if (current < 0 || current === target) continue;
      list.move(current, Math.min(target, list.length - 1));
    }
  }
}

/** Write the `galley:` identity into frontmatter if it is not already there. */
function ensureIdentity(source: string, docId: string, owner?: string): string {
  const parsed = parseDocument(source);
  const existing = parsed.frontmatter?.data.galley;
  if (typeof existing === 'string' && existing.length > 0) return source;
  const entries: Record<string, unknown> = { galley: docId };
  if (owner && parsed.frontmatter?.data.owner === undefined) entries.owner = owner;
  return setFrontmatterKeys(parsed, entries);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
