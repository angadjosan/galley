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
  /**
   * Cached bytes and parse, keyed on the CRDT's version.
   *
   * One mutation used to parse the whole document three times — the
   * whole-replacement guard, `applyOps`, and the staleness refresh each called
   * `parsed()`, which is `parseDocument(toMarkdown())`. Measured at 55% of a
   * PATCH's median on a 200-block document.
   *
   * The version vector is the exact invalidation key: it changes on every
   * commit and on every import, and on nothing else.
   */
  private cache: { version: string; markdown?: string; parsed?: ParsedDocument } | null = null;

  private constructor(readonly loro: LoroDoc) {}

  private cacheEntry(): { version: string; markdown?: string; parsed?: ParsedDocument } {
    // `version()` hands back a handle of its own, on a path called for every
    // read — so it is freed here too. A cache that leaks is not a cache.
    const vv = this.loro.version();
    const version = Buffer.from(vv.encode()).toString('base64');
    release(vv);
    if (!this.cache || this.cache.version !== version) this.cache = { version };
    return this.cache;
  }

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
    const entry = this.cacheEntry();
    entry.markdown ??= assemble(this.segmented());
    return entry.markdown;
  }

  segmented(): SegmentedDocument {
    const list = this.segmentList();
    const segments: Segment[] = [];
    for (let i = 0; i < list.length; i++) {
      const map = list.get(i) as LoroMap;
      const text = map.get('text') as LoroText;
      segments.push({
        sid: map.get('sid') as string,
        text: text.toString(),
        separator: (map.get('sep') as string | undefined) ?? '',
      });
      // Each `get` hands back a handle backed by WASM memory that is not
      // reclaimed until a GC runs. This is the hottest read path in the system
      // — every read and every write calls it — and leaving the handles to the
      // collector retained kilobytes per read on a medium document. Freeing a
      // handle releases the handle, not the data.
      release(text, map);
    }
    const preamble = this.loro.getText(PREAMBLE);
    const text = preamble.toString();
    // The container handles themselves leak too, just more slowly than the
    // per-segment ones: two per call, on a path called for every read.
    release(preamble, list);
    return { preamble: text, segments };
  }

  /** Parse the current bytes. Callers that need blocks use this, not the CRDT. */
  parsed(): ParsedDocument {
    const entry = this.cacheEntry();
    entry.parsed ??= parseDocument(this.toMarkdown());
    return entry.parsed;
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

    // One index built here and maintained through the mutations below.
    //
    // The obvious implementation looks up each sid by scanning the list, and
    // that is O(N) *WASM calls* per lookup — so a save touching every segment
    // is O(N²) round trips into the CRDT. Measured, that took a 200-block
    // document from 8ms per edit to 127ms, and it gets worse from there. The
    // mirror below is the same information in plain JavaScript.
    let order = this.sidOrder(list);
    const indexOf = (sid: string): number => order.indexOf(sid);

    // Updates, addressed by sid so the deletes above cannot shift them.
    for (const step of steps) {
      if (step.kind !== 'update') continue;
      const index = indexOf(step.sid);
      if (index < 0) continue;
      const map = list.get(index) as LoroMap;
      const text = map.get('text') as LoroText;
      const splice = minimalSplice(text.toString(), step.text);
      if (splice) {
        text.delete(splice.index, splice.deleteCount);
        if (splice.insert) text.insert(splice.index, splice.insert);
      }
      if ((map.get('sep') as string | undefined) !== step.separator) map.set('sep', step.separator);
      release(text, map);
    }

    // Inserts ascend by target index so each lands in the right place.
    const inserts = steps
      .filter((s): s is Extract<ReconcileStep, { kind: 'insert' }> => s.kind === 'insert')
      .sort((a, b) => a.at - b.at);
    for (const step of inserts) {
      const at = Math.min(step.at, list.length);
      const sid = blockId();
      this.insertSegment(list, at, sid, step.text, step.separator);
      order.splice(at, 0, sid);
    }

    // Finally, reorder to the target sequence. Moves are a distinct operation
    // in a movable list: a section that moved keeps its identity, and so does
    // every comment anchored inside it.
    order = this.reorderTo(list, order, steps);

    // Separators on kept segments can still change even when their text did not
    // — inserting a section changes what precedes it.
    for (const step of steps) {
      if (step.kind !== 'keep') continue;
      const index = order.indexOf(step.sid);
      if (index < 0) continue;
      const map = list.get(index) as LoroMap;
      const target = after.segments[step.to]!;
      if ((map.get('sep') as string | undefined) !== target.separator) map.set('sep', target.separator);
      release(map);
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
    const from = VersionVector.decode(version);
    const update = this.loro.export({ mode: 'update', from });
    release(from);
    return update;
  }

  /**
   * Would applying this update keep the document being *this* document?
   *
   * Two `GalleyDocument`s use the same container names, so an update from a
   * different document merges cleanly and splices its frontmatter — and its
   * `galley:` identity — into this one. The bytes still parse, which makes it
   * worse rather than better: nothing downstream notices, and the file written
   * to disk claims to be a document it is not.
   *
   * The check applies the update to a throwaway copy and asks whether the
   * document still knows who it is. That costs a snapshot round trip per
   * inbound update, which is the honest price of not trusting a client's
   * operations — and cheap next to the alternative.
   */
  validateUpdate(update: Uint8Array): { ok: true } | { ok: false; reason: string } {
    let probe: GalleyDocument;
    try {
      probe = GalleyDocument.open(this.snapshot());
      probe.importUpdates(update);
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : 'unreadable update' };
    }
    if (probe.docId !== this.docId) {
      return { ok: false, reason: 'this update belongs to a different document' };
    }
    const markdown = probe.toMarkdown();
    const frontmatterBlocks = (markdown.match(/^---$/gm) ?? []).length;
    if (frontmatterBlocks > 2) {
      return { ok: false, reason: 'this update would add a second frontmatter block' };
    }
    if ((markdown.match(/^galley:/gm) ?? []).length > 1) {
      return { ok: false, reason: 'this update would give the document a second identity' };
    }
    return { ok: true };
  }

  /** Apply remote operations. Returns whether anything changed. */
  importUpdates(update: Uint8Array): boolean {
    const before = this.versionVector();
    this.loro.import(update);
    const after = this.versionVector();
    return !equalBytes(before, after);
  }

  versionVector(): Uint8Array {
    const vv = this.loro.version();
    const encoded = vv.encode();
    release(vv);
    return encoded;
  }

  subscribe(handler: () => void): () => void {
    return this.loro.subscribe(() => handler());
  }

  /**
   * Release the document's native memory.
   *
   * A `LoroDoc` holds a WASM allocation that a garbage collection reclaims only
   * eventually, and an evicted document is not referenced by anything that
   * would prompt one. Measured at roughly 300KB retained per open — fifteen
   * times the snapshot — with per-open cost drifting from 0.9ms to 2.0ms as it
   * accumulated. Under LRU thrash that is most requests.
   *
   * After this the document must not be used again.
   */
  dispose(): void {
    this.cache = null;
    try {
      (this.loro as unknown as { free?: () => void }).free?.();
    } catch {
      // Already released. Nothing to do, and nothing worth failing a shutdown
      // over.
    }
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
    release(container, map);
  }

  /** The list's segment ids, in order. One pass, N WASM calls. */
  private sidOrder(list: LoroMovableList): string[] {
    const out: string[] = new Array(list.length);
    for (let i = 0; i < list.length; i++) {
      const map = list.get(i) as LoroMap;
      out[i] = map.get('sid') as string;
      release(map);
    }
    return out;
  }

  /**
   * Move surviving segments into their target order.
   *
   * Takes and returns the *current* order as a plain array, mirroring each move
   * locally rather than re-reading positions from the CRDT. The reason is
   * measured rather than aesthetic: re-reading is a linear scan of WASM calls
   * per move, which made an ordinary edit to a 200-block document cost more
   * than a tenth of a second.
   *
   * Selection-sort over the mirror is fine — reorderings are rare and small,
   * and the common case exits immediately because the order already matches.
   */
  private reorderTo(
    list: LoroMovableList,
    current: string[],
    steps: readonly ReconcileStep[],
  ): string[] {
    const desired: string[] = [];
    for (const step of steps) {
      if (step.kind === 'keep' || step.kind === 'update') desired[step.to] = step.sid;
    }
    for (const step of steps) {
      if (step.kind !== 'insert') continue;
      // Inserted segments already sit where they belong; pin them so the sort
      // below treats them as fixed points.
      if (desired[step.at] === undefined) desired[step.at] = current[step.at] ?? '';
    }

    const order = [...current];
    for (let position = 0; position < desired.length; position++) {
      const sid = desired[position];
      if (sid === undefined || sid === '') continue;
      const at = order.indexOf(sid);
      if (at < 0 || at === position) continue;
      list.move(at, Math.min(position, order.length - 1));
      order.splice(at, 1);
      order.splice(Math.min(position, order.length), 0, sid);
    }
    return order;
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

/**
 * Release transient CRDT handles.
 *
 * Every `get` on a Loro container returns a handle holding WASM memory that
 * only a garbage collection reclaims. On the read path that is called on every
 * read *and* every write, so the handles accumulate faster than the collector
 * runs — measured at roughly two kilobytes retained per read of a medium
 * document, against fifty-five bytes for the same traversal with an explicit
 * free.
 *
 * Freeing releases the *handle*, not the data: the document reads back
 * identically afterwards. Wrapped because a double free throws, and a leak that
 * turns into a crash is a worse trade than the leak.
 */
function release(...handles: { free?: () => void }[]): void {
  for (const handle of handles) {
    try {
      handle.free?.();
    } catch {
      // Already released, or a build without explicit frees. Either way there
      // is nothing to do and nothing worth failing a read over.
    }
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
