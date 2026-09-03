/**
 * Turning "the document changed underneath you" into the smallest edit that
 * says so.
 *
 * **This is what makes undo survive a collaborator.** The editor used to react
 * to a new version from the server by destroying the `EditorView` and building
 * a new one. That is correct about the *text* and catastrophic about everything
 * else attached to it: a fresh `EditorState` has a fresh history plugin, so the
 * moment anyone else touched the document your entire undo stack was gone. On a
 * shared document that is most of the time.
 *
 * Applying the change as a transaction instead keeps the state — and with it
 * the history — alive. Two properties have to hold for that to be *correct*
 * rather than merely cheaper:
 *
 * 1. **The transaction must not enter the history.** The caller marks it
 *    `addToHistory: false`, so pressing undo steps back over your own last
 *    edit and never over someone else's. Undoing a collaborator's work is not
 *    undo, it is a silent overwrite.
 * 2. **The edit must be minimal.** `prosemirror-history` rebases the steps it
 *    is holding through the mapping of every transaction that arrives. A
 *    single replace spanning the whole document maps every stored position to
 *    the same place, which turns the pending undo stack into nonsense —
 *    technically preserved, practically ruined. Replacing only the blocks that
 *    actually differ leaves every position outside them untouched, so the
 *    stack rebases exactly.
 *
 * Alignment is top-level only. Galley's documents *are* a list of blocks, the
 * server speaks in block ops, and a remote change is nearly always "this
 * paragraph is different now" — so a block-level diff is both the natural unit
 * and the one that keeps positions stable.
 *
 * Everything here is pure and works on two `PmNode`s, so the interesting part —
 * which blocks changed, and what the resulting splices are — is testable
 * without a browser or a server.
 */
/**
 * Marks a transaction as carrying somebody else's edit.
 *
 * Two things read it: the dispatcher, which must not report a remote change as
 * a local one, and anyone debugging why a transaction did not enter the
 * history. `addToHistory: false` says the second part to ProseMirror; this says
 * it to us.
 */
export const REMOTE = 'galley-remote';
/**
 * What a block is *called*, for alignment.
 *
 * A materialized block has an id and that id is its identity — it survives a
 * rewrite of every word inside it, which is the entire thesis of the product.
 * A block that has never been annotated has no id, so it is matched on its
 * content instead. That is weaker, and it is only ever used to decide *which*
 * block was edited, never to decide what a comment is anchored to.
 */
function keyOf(node, index) {
    const id = node.attrs?.blockId;
    if (id)
        return `#${id}`;
    // Type included, so a paragraph and a heading with the same words are not
    // treated as the same block moving between two types.
    return `${index}:${node.type.name}:${contentKey(node)}`;
}
/**
 * Attributes that describe where a node *came from* rather than what it is.
 *
 * `source` holds the block's original Markdown and `sep` the whitespace that
 * followed it — both exist so an untouched block can be written back byte for
 * byte, and neither is part of what the block says.
 *
 * They have to be excluded from comparison, and the failure when they were not
 * is instructive: a locally edited paragraph keeps its *old* `source` until the
 * document is reparsed, while the same paragraph arriving from the server
 * carries the new one. Two nodes with identical text compared unequal, the
 * aligner paired nothing, and a one-block change came back as a splice across
 * the whole tail of the document — which is precisely the over-broad splice
 * that ruins the undo stack it was meant to protect.
 */
const PROVENANCE = new Set(['source', 'sep']);
/** A block's content, flattened enough to compare. */
function contentKey(node) {
    return JSON.stringify(stripProvenance(node.toJSON()));
}
function stripProvenance(value) {
    if (Array.isArray(value))
        return value.map(stripProvenance);
    if (!value || typeof value !== 'object')
        return value;
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
        if (key === 'attrs' && inner && typeof inner === 'object') {
            const attrs = {};
            for (const [name, attr] of Object.entries(inner)) {
                if (!PROVENANCE.has(name))
                    attrs[name] = attr;
            }
            out[key] = attrs;
            continue;
        }
        out[key] = stripProvenance(inner);
    }
    return out;
}
/** Are these the same block, in the sense that one became the other? */
function sameIdentity(a, b) {
    const left = a.attrs?.blockId;
    const right = b.attrs?.blockId;
    if (left && right)
        return left === right;
    return false;
}
/**
 * The splices that turn `current` into `next`, in document order.
 *
 * The caller applies them **back to front**, so that each `from`/`to` still
 * refers to the document the positions were computed against.
 *
 * Returns `null` when the two documents cannot be aligned block by block —
 * a restore that replaces everything, say. The caller falls back to a rebuild
 * there, which is the honest answer: nothing about the old document survived,
 * so there is no undo stack worth rebasing onto it.
 */
export function reconcile(current, next) {
    const before = childrenOf(current);
    const after = childrenOf(next);
    // A document that shares nothing with the one on screen is a replacement,
    // not an edit. Aligning it block by block would emit a splice per block and
    // map the history onto a document it has no relationship with.
    if (before.length > 0 && after.length > 0 && overlap(before, after) === 0)
        return null;
    const matches = align(before, after);
    const splices = [];
    let i = 0;
    let j = 0;
    for (const [bi, aj] of [...matches, [before.length, after.length]]) {
        // Everything between the last match and this one differs: emit it as one
        // splice rather than as a delete and an insert, so a paragraph that was
        // rewritten stays one block rather than becoming a new one.
        if (bi > i || aj > j) {
            const from = before[i]?.pos ?? endOf(before, current);
            const to = bi > i ? before[bi - 1].pos + before[bi - 1].node.nodeSize : from;
            splices.push({ from, to, nodes: after.slice(j, aj).map((entry) => entry.node) });
        }
        // The matched pair itself may still differ in content — same id, new words.
        if (bi < before.length && aj < after.length) {
            const left = before[bi];
            const right = after[aj];
            // `PmNode.eq` compares every attribute, including the provenance ones —
            // so a block I edited locally, whose text the server has now echoed back
            // to me verbatim, would still be "different" and get replaced. Replacing
            // it is not harmless: the splice sits across the very range my pending
            // undo step points into, and rebasing through it makes the undo a no-op.
            if (contentKey(left.node) !== contentKey(right.node)) {
                splices.push({
                    from: left.pos,
                    to: left.pos + left.node.nodeSize,
                    nodes: [right.node],
                });
            }
        }
        i = bi + 1;
        j = aj + 1;
    }
    return splices;
}
function childrenOf(doc) {
    const out = [];
    let pos = 0;
    doc.forEach((node) => {
        out.push({ node, pos });
        pos += node.nodeSize;
    });
    return out;
}
function endOf(entries, doc) {
    const last = entries.at(-1);
    return last ? last.pos + last.node.nodeSize : doc.content.size;
}
/** How many blocks the two versions have in common at all. */
function overlap(before, after) {
    const keys = new Set(after.map((entry, index) => keyOf(entry.node, index)));
    const ids = new Set(after.map((entry) => entry.node.attrs?.blockId).filter(Boolean));
    let shared = 0;
    before.forEach((entry, index) => {
        const id = entry.node.attrs?.blockId;
        if (id ? ids.has(id) : keys.has(keyOf(entry.node, index)))
            shared += 1;
    });
    return shared;
}
/**
 * Pairs of indices that are the same block, longest common subsequence.
 *
 * Classic dynamic programming. Top-level block counts are in the hundreds for
 * even a long document — the design doc in this repo is about 300 — so the
 * quadratic table is a few tens of thousands of small integers, computed once
 * per remote change rather than per keystroke.
 */
function align(before, after) {
    const n = before.length;
    const m = after.length;
    const table = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    const same = (i, j) => {
        const left = before[i].node;
        const right = after[j].node;
        // Identity first: a block with an id that is still present is the same
        // block even if every word in it changed.
        if (sameIdentity(left, right))
            return true;
        const leftId = left.attrs?.blockId;
        const rightId = right.attrs?.blockId;
        // One side has an id and the other does not: not the same block. Matching
        // them would let an annotated block silently become an unannotated one.
        if (leftId || rightId)
            return false;
        return left.type === right.type && contentKey(left) === contentKey(right);
    };
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            table[i][j] = same(i, j)
                ? table[i + 1][j + 1] + 1
                : Math.max(table[i + 1][j], table[i][j + 1]);
        }
    }
    const pairs = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (same(i, j)) {
            pairs.push([i, j]);
            i += 1;
            j += 1;
        }
        else if (table[i + 1][j] >= table[i][j + 1]) {
            i += 1;
        }
        else {
            j += 1;
        }
    }
    return pairs;
}
//# sourceMappingURL=reconcile.js.map