# Decisions

Technical decisions made while building Galley, and the context behind them. A
log — append, don't rewrite. Where a decision closed a fork worth remembering,
the rejected branch goes in `tradeoffs.md` and this file links to it.

Distinction from `tradeoffs.md`: that file records *forks* (what we didn't do,
and why the rejected option keeps looking attractive). This file records *what
is true about the codebase* and why a reader should not "fix" it.

---

## D1 — TypeScript monorepo, npm workspaces

**Context:** the product is a CLI, a server, and a browser editor over one
document model. The model must be *literally the same code* in all three or the
CLI and the app will drift on block identity, which is the technical thesis.

**Decision:** one TypeScript monorepo. `npm` workspaces rather than pnpm —
`pnpm` isn't on this machine and the workspace graph is small enough that npm's
hoisting is not a problem. Packages export `src/*.ts` directly and are consumed
by `tsx`/`vite`/`vitest`, so there is no build step between packages during
development; `tsc --build` exists purely as a typecheck gate.

**Consequence:** `npm run typecheck` is a required gate before every commit. A
package that only ever runs through a bundler can otherwise accumulate type
errors invisibly.

---

## D2 — Concurrency is its own package, built first

**Context:** the brief asks for a system that is robust under saturation, has
defined behavior on partial failure, and has no race conditions in the sync
path. Retrofitting that onto ad-hoc `async` code is not possible.

**Decision:** `@galley/concurrency` is written and tested before any product
code, and every shared-state mutation in the server goes through one of its
primitives. Nothing in the codebase is allowed to hand-roll a lock.

The primitive set is chosen from the actual hazards in the design doc:

| Hazard from `idea.md` | Primitive |
|---|---|
| Two clients apply ops to one doc concurrently | `Mutex` per doc, FIFO-fair |
| A doc is read while being spliced to disk | `RwLock` |
| Cross-doc operations (transclusion, move) deadlock | `KeyedMutex.acquireOrdered` — global lock order, violation throws |
| A fast producer overruns a slow WebSocket | bounded `Channel` with backpressure |
| Ops must apply in causal order per doc | `Sequencer` (serialized per key, ordered) |
| A crashed producer leaves consumers parked | `Channel.fault(cause)` → every waiter rejects with `FaultedError` |
| A wedged downstream (git, email) stalls the hub | `CircuitBreaker` + `withTimeout` |

**Rejected:** using `async-mutex` / `p-queue` off the shelf. They are fine
libraries, but none of them expose cancellation-safe acquire, fairness
guarantees we can assert on in tests, or fault propagation distinct from close.
Those three properties are exactly what the stress suite needs to test.

---

## D3 — Errors are a closed taxonomy, not strings

Cancellation, timeout, clean close, abnormal fault, capacity rejection, and lock
order violation are six *different* events, and a consumer that cannot tell them
apart will either swallow a real fault or invent one. `src/errors.ts` defines
all six; nothing in the codebase throws a bare `Error` across an async boundary.

The one that carries the most weight is `ClosedError` vs `FaultedError`. "The
stream ended" and "the stream broke" look identical to a `for await` loop unless
the primitive forces the distinction, and the difference decides whether a
consumer commits its work or rolls it back.

---

## D4 — A block is a flow node, at any depth

**Context:** block granularity decides what a comment can be attached to, what
an agent can cite, and what a suggestion can scope itself to.

**Decision:** every flow node is a block, including ones nested inside lists and
blockquotes. A paragraph in the third bullet has its own identity, because "the
spec contradicts itself between bullet three and bullet five" has to be
expressible.

Container nodes (`list`, `listItem`, `blockquote`) are blocks too — they carry
identity so a structural move survives — but they are not `editable`. Their
content *is* their children, and rewriting a container directly would mean
re-serializing everything inside it, which is exactly what the splicing rule
forbids.

**Consequence:** a naive search for a block by its text finds the enclosing
container first, since a container's text is its children's text concatenated.
Callers that mean "the paragraph" must filter on `editable`.

---

## D5 — Id markers are trailing and inline, not own-line

**Context:** `idea.md` specifies materializing a block id into the file as an
HTML comment. It does not specify where, and the placement turns out to decide
whether the mechanism works at all.

**First attempt:** an own-line comment above the block, `<!-- ^a1b2c3 -->\n`.
Clean to parse, works for every block type, and **splits a tight list in two**:
an HTML block between two list items ends the list. The property test caught it
against a corpus list; a hand-written test would not have.

**Decision:** the marker is appended to the end of the block, inline —
`A paragraph. <!-- ^a1b2c3 -->`. Inline HTML is phrasing content, so it changes
nothing structurally, anywhere: top level, inside a blockquote, inside the third
bullet of a nested list.

**Cost, stated rather than worked around:** only blocks with inline content —
paragraphs and headings — can carry a materialized id. A table, a fenced code
block, or a list container falls back to fuzzy re-anchoring (rule 2 in
`idea.md`'s block-identity section). That is an acceptable trade, and arguably
the right one: content-similarity anchoring is *more* reliable for those types
than for prose, because a code block's content is far more distinctive than a
sentence.

**Consequence that pays for itself:** the marker sits *outside* the block's
range. A `replace` op rewrites the content and cannot touch the identity, which
makes Walkthrough B — an agent rewriting a commented paragraph, comment still
attached — true by construction rather than by care.

---

## D6 — Structural spacing is measured, never assumed

An insert used to emit a fixed separator. That reformats the surroundings of
every insertion: a blank line appears between two items of a tight list, or a
document that separates blocks with two blank lines gets one.

The separator is now read off the document at the insertion point — the gap
between the anchor and its neighbour — and reproduced. Same principle as the
splicer one level up: match what is there, do not impose what we prefer.

---

## D7 — An empty replace is refused, not performed

Replacing a block's content with nothing leaves its container prefix stranded:
a bare `- ` or `> ` with trailing whitespace. That is a delete wearing the wrong
name. `replace` with empty content throws and names the op the caller wanted.

Found by the property test's "no line acquires trailing whitespace" invariant,
which is a good example of why the invariants are worth more than the
assertions: nobody would have written a test for "replace a bullet with an
empty string".

---

## D8 — A move onto its own position is a no-op, not a conflict

`move X after Y` where X already directly follows Y produces a delete range and
an insert point *inside* it. The splicer's overlap check — which exists to
refuse two proposals touching the same bytes — fired on it.

Treating that as a conflict would make an idempotent reordering fail on its
second application, which is exactly what a retrying agent does. The move now
detects that the destination lies inside the vacated region and emits nothing.

---

## D9 — Re-anchoring: ambiguity is judged on content, never on context

**Context:** `idea.md` sets the gate — ≥95% anchor survival across realistic
agent rewrites, **zero silent misattachments**, and says explicitly that the two
are not traded off against each other.

**Decision:** three signals, in strict priority.

1. **A materialized id wins outright.** No inference runs at all.
2. **Fuzzy matching** combines text similarity (0.62), neighbour hashes (0.12),
   heading trail (0.10), relative position (0.08) and nesting depth (0.08),
   with block type as a *hard gate* rather than a weighted signal — a heading
   and a paragraph with the same words are not the same block.
3. **Below threshold, or ambiguous, the anchor orphans** carrying its
   last-known text.

Two rules do the real work of holding misattachments at zero:

**A minimum text similarity vetoes any match, regardless of the combined
score.** Without it, a block whose content was replaced outright still gets
claimed by an anchor purely because it sits at the same index, under the same
heading, between the same neighbours. That is a misattachment dressed up as high
confidence.

**The ambiguity margin is measured on the text signal alone.** This is the
subtle one, and it came out of the benchmark. When an agent splits a paragraph
in two, both halves are equally the original — but one of them inherits the
original's neighbours and position, so the *combined* score separates them
cleanly and the anchor lands on it with 0.90 confidence. Context broke a tie
that content could not, and it broke it arbitrarily. Judging the margin on text
sends the anchor to the orphan tray instead, where a human decides which half
their comment was about.

**Similarity is Dice plus containment.** Dice alone punishes the two commonest
agent edits — "tighten this" and "expand on this" — because its denominator is
the sum of both sizes; a paragraph that doubled in length scores ~0.67 against
its own original. The overlap coefficient reads that as containment. It is only
consulted for texts long enough for containment to be evidence, and only when
the size ratio is under 2.5:1 — beyond that, containment means something else
entirely (a short paragraph quoted inside a long one), which was the source of
the last misattachment in the benchmark.

**Assignment is one-to-one and globally greedy.** The highest-scoring pair
anywhere is fixed first and both sides leave the pool. A per-anchor best-match
loop lets an early anchor claim a block a later anchor matched far better, which
is how an entire document's comments end up shifted by one paragraph.

**Measured:** 10,421 anchors over the corpus and this repo's own design docs,
across rewrite intensities from a touch-up to a heavy section rewrite —
**98.13% survival, 0 misattachments**, and all 242 deleted blocks correctly
orphaned.

---

## D10 — When the benchmark and the code disagree, check which one is lying

Three rounds of benchmark failures were fixed in the *test*, not the code, and
that is worth recording because it is the easy thing to get wrong.

The generator originally asserted that a split paragraph had one correct
successor, that a second split overwrote the first, and that deleting one
fragment of a split block orphaned the anchor even while other fragments
survived. All three are false statements about the domain, not bugs in the
matcher.

The distinction that kept this honest: an assertion was only relaxed when it
asserted something untrue of the world, and every relaxation *widened the set of
correct answers without weakening the misattachment gate* — landing outside that
set is still a failure. The two changes that were genuine code fixes (the text
similarity veto, and the containment size-ratio cap) both made the matcher
*stricter*, never more permissive.

---

## D11 — The CRDT holds top-level segments, not a block tree

**Context:** `idea.md` commits to Loro, and to the CRDT being the source of
truth during a session. It does not say what shape the document takes inside it,
and the shape decides whether byte fidelity survives contact with multiplayer.

**Decision:**

```
LoroDoc
  ├ meta      LoroMap    galley id, title, owner
  ├ preamble  LoroText   frontmatter and leading whitespace, verbatim
  └ segments  LoroMovableList of LoroMap { sid, text: LoroText, sep }
```

`toMarkdown()` is `preamble + Σ(text + separator)`. There is **no serializer in
the path at all** — the bytes are stored, not regenerated, so byte fidelity is a
property of the data structure rather than something the code has to be careful
about.

Storing the separator *on the segment* rather than deriving it is what makes
this exact: a document that puts two blank lines between sections, or ends
without a newline, reassembles as written.

**Top-level only.** A list is one segment, not one per item. Nested containers
would force the reassembler to understand list markers and blockquote prefixes,
which is the AST-to-text serialization this codebase exists to avoid. Nested
blocks are not identity-less — they get sidecar ids, materialize inline markers,
and are addressed by block ops *within* a segment. What they do not get is a
CRDT list position.

**A movable list, not a plain one.** "Move this section above that one" is then
a first-class operation instead of a delete plus an insert. The difference is
visible to users: delete-and-insert loses the section's identity, and with it
every comment anchored inside it.

**Reconciliation is how bytes become CRDT ops.** `setMarkdown` diffs the new
segmentation against the old — exact matches by LCS first, then similar
leftovers above a floor, then genuine inserts and deletes — and applies the
result as a character-level splice per changed segment. An edited paragraph is
an *update*, so a concurrent edit elsewhere in it still merges.

---

## D12 — One sequencer per document, and the ticket is the version number

The first implementation shared one `Sequencer` across every document, with a
lane per document. It deadlocked the first time a session boundary was taken
from inside a lane, and the fix revealed the real design.

A document's ticket now orders *that document's* operations and nothing else.
This makes two things precise that a shared counter left approximate: a
suggestion's `baseTicket` is a version of the document it targets, and the drain
at a session boundary waits on that document rather than on unrelated traffic.

**The boundary is the operation's own ticket.** `seal(key, ownTicket + 1)`, not
`seal(key)`. Sealing at the current cursor admits work that was queued *behind*
the sealing task while it waited — precisely the edit that must not leak into
the version being closed. The sequencer now also re-checks the cutoff in its
pump, because a task can be sealed out after it was already queued.

The bug it fixed was a hang, and it was found by the test that asserts the
boundary loses nothing and admits nothing — which is why that test asserts both
halves rather than just the easy one.

---

## D13 — Agent edits are suggestions; acceptance is a human act

`idea.md` calls suggestion-by-default the trust primitive of the product. Two
enforcements in `DocumentActor` make it a property rather than a convention:

- `acceptSuggestion` refuses any agent principal outright, including the author
  of the proposal. There is no rule a sponsor can write that auto-accepts.
- `stale` is terminal for acceptance. A proposal whose anchor moved would apply
  an edit to text its author never saw; re-proposing is the author's job.

Staleness is judged on **content hashes, not timestamps**. A block edited and
then edited back is byte-identical to what the proposer saw — but it still goes
stale on the first edit, and stays stale, because the author never saw the round
trip and the reviewer should know one happened.
