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

---

## D14 — `node:sqlite`, loaded through `process.getBuiltinModule`

**Storage:** `node:sqlite` rather than `better-sqlite3`. It ships with the
runtime, so there is no native build step in the install path — which matters
disproportionately for a product whose CLI people install on a laptop and expect
to work immediately. It carries FTS5, which is the only non-obvious requirement.

**Loading:** `process.getBuiltinModule('node:sqlite')`, not a static import.
Bundlers do not yet recognise it as a builtin and try to resolve it as a package
on disk. This form is opaque to static analysis and resolves to the same module
at runtime, so the test runner, a bundled CLI, and a plain `node` process all
behave identically. A bundler config workaround would have to be repeated in
every consumer; this is fixed once, here.

**The synchronous API is a feature.** A synchronous critical section cannot be
interleaved by the event loop, so a multi-statement transaction is atomic
without any locking discipline of its own. The obligation it creates is stated
in the file: every statement is prepared once and no query is unbounded.

---

## D15 — A slow sync client is disconnected, never dropped-to and never waited-on

Three options for a WebSocket client that stops reading:

| Policy | Failure |
|---|---|
| Block | One stalled browser tab stalls everyone's editing. |
| Drop frames | The client misses a CRDT operation and is **permanently diverged**, while looking fine. |
| Disconnect | Costs that client a reconnect. Costs everyone else nothing. |

Disconnect is the only one that cannot leave a document looking correct while
being wrong. The outbound channel is therefore `reject`-on-full rather than
`drop-oldest`: a full buffer means "this client is behind", and the answer is to
close it with a reason and let it resync from a snapshot.

Two follow-on details the tests forced out:

**A graceful close must flush before the socket goes.** The first implementation
closed the socket inside `close()`, which threw away the queued `ended` frame —
the one frame the client most needs, because it says *why*. The channel now
closes, the writer drains it, and the writer closes the socket.

**A close handshake needs a grace period.** `ws` waits 30 seconds for the peer
to answer a close, and the peer being closed is very often precisely the one
that stopped reading. That pinned a socket, a connection slot and a document
reference for 30 seconds per dead client. There is now a one-second grace period
and then `terminate()`. Found because a test took 30 seconds; it was a server
defect, not a slow test.

---

## D16 — Whole-document replacement is refused by the server, not just the CLI

`idea.md` puts this in the CLI: "the CLI enforces the shape, because etiquette
that isn't enforced is a suggestion to a model." The same argument applies one
layer down — the CLI is not the only thing that will ever call the API. An
operation set that deletes every anchored block in a document is refused with a
message naming the alternative, at the HTTP boundary.

---

## D17 — `galley push` derives block ops from a local diff

**Context:** `tradeoffs.md` leans to the checkout model — the cloud is the home,
the local copy is a checkout. That leaves one question: what does a local edit
become when it goes back?

**Decision:** `push` reads the current server version, segments both sides,
reconciles them, and sends **scoped block operations** — the same vocabulary
`galley suggest` uses. A person edits a file in their own editor and what
reaches the server is `replace @3` and `insert after @5`, not a blob.

This is what makes the checkout model *better* rather than merely cheaper. Block
identity survives a local edit by construction, exactly as it does for an
in-app one, so a comment thread on a paragraph someone edited in vim is still
attached afterwards. And a local edit that arrives after the cloud document
moved on is a **suggestion** — conflict resolution stops being a subsystem and
becomes an existing feature with a different author field.

**Default is propose, not write.** `--write` exists for a principal who has
write access and wants it, and it is a deliberate act.

**Both paths refuse a whole-document replacement**, with a message that names
what to do instead. The reuse here is the point: the same refusal, the same
threshold and the same reasoning cover an agent's proposal, a human's local
edit, and an inbound file from disk.

---

## D18 — The CLI has no runtime dependencies

`galley` is the thing agents run, and every dependency in its install path is a
way for `npm i -g galley` to fail on someone's laptop at the exact moment they
are deciding whether this product works. The argument parser is forty lines and
owned here rather than pulled in.

`galley read` writes the document's bytes and nothing else — no banner, no
progress, no colour — because `galley read spec | claude -p "implement this"` is
a real workflow and anything else on stdout corrupts it. The tests assert the
absence, including of ANSI escapes.

Exit codes carry meaning a script can branch on: 0 success, 1 a runtime failure
or an empty result where empty is meaningful (`search` with no hits, `status
--stale` when something drifted), 2 a usage error.

---

## D19 — The editor re-emits untouched blocks from their stored bytes

The splicing engine guarantees byte stability for edits expressed as block ops.
The editor is the one component that can break that guarantee anyway, by loading
a document into ProseMirror and serializing the whole thing back.

So every top-level node carries the Markdown it was built from in a `source`
attribute, plus its exact separator. On save, a node still deep-equal to the
node that source produced emits `source` verbatim; only genuinely edited blocks
reach the serializer. Opening a document and saving it untouched is byte-
identical across the same corpus the round-trip engine uses, including this
repo's own design docs.

Two things the editor does change, stated rather than hidden:

- **Soft line breaks in an edited block are folded.** Markdown's line wrapping
  is not the author's intent — `a\nb` renders as `a b` everywhere — and
  ProseMirror's `pre-wrap` would otherwise display it as a real break. An
  untouched block keeps its wrapping; an edited one reflows onto one line, which
  is what every WYSIWYG does.
- **A construct the schema cannot model** (a link reference definition, a
  footnote definition) becomes a `raw_block`: shown, not editable, and re-emitted
  verbatim. Dropping it would delete content; approximating it would reformat it.

---

## D20 — The browser shares the packages, so the packages cannot assume Node

`@galley/client`, `@galley/core`'s diff and segmentation, `@galley/anchor` and
`@galley/markdown` all run in the browser as well as on the server — deliberately,
because a second implementation of block identity would drift from the first,
and the whole product rests on the two agreeing.

That forced three changes, each of which is better than what it replaced:

- **Content fingerprints are portable JavaScript**, not `node:crypto`. WebCrypto's
  digest is async and every caller is sync. Non-cryptographic is right and worth
  saying out loud: it answers "is this the same paragraph", not "is this
  authentic". Token hashing, which *is* adversarial, stays on SHA-256 in the
  server and always will.
- **Ids use `crypto.getRandomValues`**, present and strong in Node 22 and every
  browser.
- **`KeyedMutex` resolves `AsyncLocalStorage` at runtime** and degrades to a
  no-op when it is absent. The mutex still serializes identically; only the
  lock-order *diagnostic* is unavailable, and the cross-document operations it
  guards are server-side.

The browser also does not need the CRDT — it refetches on change rather than
applying deltas locally — so the editor imports `@galley/core/segments` and
`@galley/core/diff` directly rather than the package index, which would pull in
Loro's WASM for nothing.

---

## D21 — `?markers=1`: the editor reads the annotated form

`GET /v1/docs/:ref` strips id markers by default. Every agent, the CLI, and
`galley pull` get the clean bytes `idea.md` promises.

The editor asks for `?markers=1`, and that is not a loophole: the editor **is**
the annotation surface, and it needs the ids to know which paragraph a comment
belongs to. Everything downstream of a read still gets the clean form.

The bug this fixed was worth the round trip to find: without markers the editor
had no block ids at all, so the comment composer stayed disabled and there was
no way to annotate anything from the app.

---

## D22 — Three bugs from moving markers to the end of a block

D5 moved the id marker from its own line above a block to inline at the end of
it. Three call sites still assumed the old placement, and all three were found
by driving the real UI rather than by a unit test:

1. **`segment()`** started a block at `lineStart(markerRange.start)`. With a
   trailing marker that is the block's *last* line, so a multi-line paragraph's
   first line was handed to the previous block's separator — and saving an edit
   duplicated half the paragraph.
2. **`deleteEdit`** had the same assumption, so deleting a multi-line annotated
   block left its first line behind.
3. **`stripTrailingMarker`** in `diffToBlockOps` stripped the marker from *any*
   replacement text. Correct for a leaf block, whose marker sits outside its
   content range — and wrong for a container, whose range covers its children
   and whose trailing marker belongs to its **last child**. Editing any bullet
   re-serializes the whole list, so a comment on the last bullet was detached
   every time a sibling was edited.

The general lesson, recorded because it will recur: `markerRange` says *where a
block's own marker is*, and `range` says *where its content is*. Any code that
uses one to answer a question about the other is wrong in one of the two marker
placements, and both placements have now shipped.

---

## D23 — Reconciliation pairs by position when content is unrecognizable

A paragraph rewritten from scratch shares almost no text with what it replaced,
so similarity matching will not pair it — and calling that a delete plus an
insert loses the block's identity, which is the one thing this codebase exists
to preserve.

A third pass pairs leftovers by position, bounded by exact matches on both
sides: between two blocks that are byte-identical before and after, exactly one
unmatched block on each side can only be the same block, rewritten. The exact
anchors are what make it safe — it cannot pair across a region where anything
else moved — and the strict 1:1 requirement is what keeps it from guessing when
an edit and an insertion happened in the same gap.

---

## D24 — The write path was O(N²) in WASM calls; it is now linear

**Found by measurement, not review.** The first concurrency stress run appeared
to hang. `tests/stress/scaling.test.ts` exists because "appeared to hang" needs
a number behind it before anyone starts optimising, and the number was stark:

| document size | per-edit p50 | p90 |
|---|---|---|
| 25 blocks | 2.1 ms | 2.5 ms |
| 100 blocks | 8.6 ms | 11.6 ms |
| **200 blocks** | **126.9 ms** | **511.1 ms** |

The cause was `indexOfSid`, which found a segment by scanning the Loro list —
one WASM round trip per element. `setMarkdown` called it once per updated
segment, once per kept segment, and once per move, so a save touching every
segment was O(N²) round trips.

The fix is a plain-JavaScript mirror of the segment order, built once per save
(N calls) and maintained through the deletes, inserts and moves. Same result,
same CRDT operations:

| document size | per-edit p50 | p90 |
|---|---|---|
| 25 blocks | 2.1 ms | 2.5 ms |
| 100 blocks | 4.6 ms | 5.9 ms |
| **200 blocks** | **9.1 ms** | **11.9 ms** |

14× at 200 blocks, and the growth is now linear rather than quadratic. A
200-block document is a medium-length spec — this was not a scale problem for
later, it was a problem at the size the product is *for*.

---

## D25 — Eviction must not run while holding a document lock

The `KeyedMutex` lock-order check fired during the cross-document storm:

```
lock order violation in documents: holding [01KZ8DD5VN…] and acquiring 01KZ8DD5V8…
```

`openDocument(A)` held A's lock, and inside it `attach()` triggered
`evictIfNeeded()`, which takes *another* document's lock to close it. Two
concurrent opens of A and B could each hold their own and reach for the other's:
a textbook inversion, and a real deadlock that would have surfaced as a hang
under memory pressure, months later, in production.

Eviction now runs after the open lock is released, and is guarded so only one
sweep is in flight. The comment at the call site says why, because the natural
place to put eviction is exactly where it was.

This is the primitive earning its keep. The check exists precisely so that this
class of bug fails loudly at the moment of the mistake rather than silently
until the day it matters.

---

## D26 — The benchmark corpus is frozen, deliberately

The anchor benchmark read this repo's design docs from the working tree, which
found real cases — two misattachments came from prose written after the gate was
first met, and both were genuine bugs in the *generator's* ground truth.

But a gate whose corpus changes whenever someone edits a document is not a gate.
It can go red on a commit that touched no code, and the first person to see that
will conclude the suite is noise. The corpus now lives in `corpus/prose/` as a
snapshot; refreshing it is a deliberate act, and a failure right after a refresh
is what it looks like — a real finding on new input.

The ground truth also changed shape while fixing those two: fragments are now
tracked by **origin identity** rather than by recorded text. Text goes stale the
moment a fragment is reworded after a split, and then the matcher gets blamed
for a bookkeeping error in the generator. Origin cannot go stale.

---

## D27 — Latency is measured and printed; only shape is asserted

Absolute latency is a property of the machine. `expect(p99).toBeLessThan(5)`
passes on a quiet laptop, fails on a loaded runner, and teaches everyone to
ignore the suite — the most expensive thing that can happen to a test suite.

So `tests/stress/latency.test.ts` prints every number and asserts only on
properties that hold anywhere:

- the tail is bounded relative to the median (a runaway ratio means a queue
  growing faster than it drains);
- throughput does not *collapse* as concurrency rises (it does not scale
  linearly either — a document is serialized by design — so the assertion is
  against an accidental global bottleneck);
- read cost grows no faster than the document does;
- fan-out cost grows no faster than the subscriber count.

**Measured on the development machine** (Node 22, in-memory store):

| path | p50 | p99 |
|---|---|---|
| `applyOps` replace, in process | 0.63 ms | 12.4 ms |
| consistent `read`, in process | 0.012 ms | 0.14 ms |
| `comment`, in process | 0.21 ms | 5.5 ms |
| HTTP PATCH, 1 client | 9.6 ms | 25 ms |
| HTTP PATCH, 64 clients on one document | 57 ms | 1067 ms |
| HTTP GET, 150-block document | 5.1 ms | 26 ms |
| HTTP PATCH with 32 live subscribers | 21.7 ms | 62 ms |

Throughput on a single document held flat from 100 ops/s at one client to
112 ops/s at sixty-four — the queueing shows up in per-request latency, which
is what serializing a document means.

**One measurement was wrong before it was right.** The first version reused one
document across all four concurrency levels, so each level ran against a bigger
document than the last and the test reported an 11× "throughput collapse" that
was entirely document growth. A benchmark that does not isolate its variable
measures the wrong thing confidently.

---

## D28 — An async method never throws synchronously

`DocumentActor.applyOps` threw synchronously when the sequencer was closed,
because `Sequencer.submit` does. An async method that *sometimes* throws instead
of rejecting is a trap: `actor.applyOps(…).catch(…)` does not catch it, and the
failure surfaces as an uncaught exception in whatever happened to be running.

Every command path now funnels through one wrapper that converts a synchronous
throw into a rejection. Found by the chaos suite asserting that a faulted
document refuses work — the assertion passed for the wrong reason until the
error stopped escaping the promise.

---

## D29 — Seven bugs from adversarial testing, and what they have in common

Two subagents were pointed at the product with one instruction — find bugs, do
not fix them — and found seven. Recorded together because the pattern matters
more than the individual fixes.

**1. A `null` WebSocket frame killed the process.** `JSON.parse('null')`
succeeds, and `null.t` throws inside a `void`-ed handler: an unhandled
rejection, and under Node's default policy a dead server. Twenty-eight other
malformed frames were handled correctly; the one that got through was the one
that *parsed*. Frames are now validated as tagged objects before anything reads
the tag.

**2. A CRDT update from another document merged cleanly.** Two documents use the
same container names, so a foreign update spliced its frontmatter — and its
`galley:` identity — into the target. The result still parsed, which made it
worse rather than better: nothing downstream noticed, and `galley pull` would
have written a file claiming to be a document it was not. Updates are now
applied to a throwaway copy and checked for identity before they are accepted.
That costs a snapshot round trip per inbound update, which is the honest price
of not trusting a client's operations.

**3–4. Path handling.** Traversal and empty paths returned 500 instead of 400 —
the refusal was right, the status said the server broke. And `.` was accepted as
a path, which `galley pull` wrote to disk as `..md`.

**5. Concurrent create across two processes.** `Store` takes a file and enables
WAL, so two servers over one database is a supported deployment. There the
check-then-insert lost to the unique constraint, surfaced a raw SQLite error as
a 500, left an unpersistable ghost document open, and broke shutdown forever
after. The constraint is now the authority and the loser cleans up after itself.

**6. `galley pull` destroyed local work.** It overwrote a modified file with no
warning and exit 0 — and `galley status` reported that file as modified
immediately beforehand, so the CLI had the information to refuse and did not.

**7. The whole-document-replacement rule refused ordinary edits**, and `push`
was a two-way diff. See D30.

**What they have in common:** every one is a case where the *unhappy* path was
never exercised, and five of the seven produce a wrong answer rather than an
error — a dead process, a document with a foreign identity, a lost file. The
happy paths had 446 tests. That is the argument for adversarial testing as a
distinct activity rather than more of the same tests.

---

## D30 — `galley push` is a three-way merge

The first implementation diffed the local copy against the *server's current*
state. That silently reverted a colleague's concurrent edit: a block this user
never touched appeared in the diff as "changed back", and push dutifully changed
it back.

`pull` now writes a **base** copy alongside the working copy — git's index, in
effect — and `push` diffs against the base. It sends what *this user* changed
and nothing else, so a concurrent edit to a different block is left alone.

The remaining hazard is a `@N` target, which names a *position* in the base. If
the remote has moved, that position may hold a different block, and editing the
wrong block is the one outcome worse than refusing. The precondition is checked
directly against the bytes — does index N still hold what it held in the base? —
rather than inferred from "the document changed somewhere", which would refuse
almost every push.

The replacement rule that gates push and suggest was also wrong for small
documents: editing the one paragraph of a two-block document is a 50% change.
It now refuses only when *nothing* survived, or when a document with enough
blocks to have an opinion lost a large majority of them. The asymmetry is
deliberate: a false positive is a hard block on someone's real work with no way
around it, and a big-but-not-total diff is handled fine as a lot of scoped
operations.

---

## D31 — What the latency campaigns found, and what was done about it

Three subagents measured the system rather than reasoning about it. Every one of
them overturned something believed on the basis of the code reading well.

**The sequencer is not the bottleneck — parsing is.** The premise "per-request
latency grows with concurrency because a document is serialized" turned out to
be true of the *observation* and false of the *mechanism*: time queued in the
`Sequencer` is 0.004–0.018 ms at every concurrency level, the smallest term in a
request. What grew was off-handler wait, because the handler was CPU-bound —
and it was CPU-bound because **one mutation parsed the whole document three
times**: the whole-replacement guard, `applyOps`, and the staleness refresh each
called `parsed()`, which is `parseDocument(toMarkdown())`. That was 55% of the
median on a 200-block document.

Fixed by memoizing bytes and parse on the CRDT's version vector — an exact
invalidation key, since it changes on every commit and import and on nothing
else — and by skipping the staleness refresh when a document has no proposals,
which is most documents.

**Three WASM leaks on the hot paths.** Loro's containers are reached through
handles that a JavaScript collection does not reclaim, because V8 sizes its
collections by the JavaScript heap and that heap barely moves when a CRDT is
discarded.

| path | before | after |
|---|---|---|
| `toMarkdown()` of a 40-segment document | 2.2 KB retained per read | 16 B |
| `GalleyDocument.open()` of a 20 KB snapshot | 305 KB retained, 15× the snapshot | 0.3 KB |
| per-open cost after 1000 opens | 0.87 ms → 2.06 ms | 0.25 ms, flat |

The open path had no release at all; documents now have `dispose()`, and the
workspace calls it on close and on eviction. Under LRU thrash that was most
requests.

**Combined effect**, measured: `applyOps` p50 0.63 → 0.44 ms, insert at 200
blocks p50 9.1 → 6.2 ms, a 200-block read 0.44 → 0.11 ms, HTTP PATCH p50 9.6 →
4.9 ms, and opening a document 3.5× faster with no drift.

**The sequencer's own observability hook was blind.** `onSettled` reported
`queuedMs` and `ranMs` from `Date.now()`, which has millisecond granularity —
against a queue wait measured in microseconds, it reported a flat zero. The one
hook that exists to report queueing could not see it. Now on `monoNow()`.

---

## D32 — The slow-client policy was documented but unreachable

`SyncConnection` documents disconnecting a client that cannot keep up, and
implements it with a bounded channel that rejects when full. Measurement showed
it never fired: **14.5 MB held for one paused client, zero disconnects.**

The writer handed each frame to `socket.send` without awaiting the drain, so the
channel emptied instantly into `ws`'s *unbounded* userspace buffer. Its depth
stayed at zero however far behind the peer was, so the capacity was never
reached and the policy was dead code describing itself.

The writer now awaits the send callback. That makes the channel the real
backpressure point — a peer that stops draining parks the writer, the channel
fills, `offer` refuses, and the client is closed with a reason. There is a
socket-buffer budget as a second line of defence, and a test that sets both low
and *proves the eviction fires* rather than asserting that it would.

The general lesson, and the reason this is recorded rather than quietly fixed: a
policy with no test that observes it firing is a comment. Everything about this
one was correct except that nothing ever reached it.

---

## D33 — Two more sync defects worth the same attention

**Every non-sender's watermark went stale.** The WebSocket write path advanced
`lastVersion` for the sender only, then relayed the update to everyone else
without advancing theirs. The next change recomputed each of their deltas from
that stale point — measured at **79× a steady-state delta** after two hundred
edits, re-sending operations every client already had. CRDT-idempotent, so not a
correctness bug; unbounded in a WebSocket-only session, which is every session.

**Presence cost the write path 2.4–3.4×.** A cursor move rebuilt the whole peer
list and sent it to every connection, so one move was O(peers) frames each
carrying O(peers) entries — roughly 70 MB/s of egress at 32 clients, for
information that is stale in a tenth of a second. Presence is now coalesced to
10 Hz with a trailing edge, and a client's cursor block id is capped, because it
is echoed to every peer and an oversized one is amplified N times per keystroke.

---

## D34 — The editor holds what it cannot represent, rather than approximating it

Three defects, one cause: the conversion into ProseMirror had no case for a
construct, so it fell through to a default that *looked* reasonable and lost
information.

- **Reference links, footnote references, image references and inline HTML**
  were flattened. `[the spec][spec]` became the words "the spec" with the
  definition left dangling; `[^1]` vanished; `![alt][img]` lost its alt text;
  `<span class="x">` came back escaped. Editing one word of a paragraph deleted
  something else in it.
- **An HTML block** was rendered as a code block, and a code block round-trips
  to a *fenced* block — so editing it turned `<div>…</div>` into ```` ```html ````
  and it stopped being HTML.
- **A body-less document** gained a newline on every open and save, without
  bound.

The rule now: anything the schema cannot model is held as an **atom carrying its
exact source**, shown as a labelled chip, and re-emitted verbatim. Shown, not
editable, is an honest third answer between dropping it and approximating it.

One detail worth its own note: a raw block's content lives in a `raw` attribute,
separate from the `source` attribute every block carries for the round-trip fast
path. They look redundant and are not — `source` is cleared whenever a block is
considered changed, and clearing a raw block's *content* along with it would
delete what it holds. A test caught that within a minute of the first attempt.

---

## D35 — What two more latency rounds found, and what changed

Two more subagents, one on tail latency and jitter, one on behaviour at and past
saturation. Between them, six things were wrong. Every number below is measured
before and after.

**A fourth instance of the D31 leak class, on the hottest path there is.**
`validateUpdate` opens a probe copy of the document per inbound frame — once per
keystroke per connected client — and never released it: **12.7 KB retained per
call** on a 40-block document, up to **392 KB** on a 320-block one. Disposing
the probe left **97 KB**, which is how the second cause surfaced: `get docId()`
was `loro.getMap(META).get(...)`, minting a wasm-bindgen handle per read and
dropping it, and `docId` is read on essentially every request. The whole class
hides behind one-line getters as readily as behind loops. Now 1.3 KB per call —
*less* than the same work with an explicit `dispose()`.

**The WebSocket edit path forced a snapshot and a full-text reindex per
keystroke.** `persist(docId, true)` inline in the frame handler, bypassing the
250 ms debounce the workspace documents as the reason a keystroke is not a disk
write. Measured at **1.00 storage transaction per inbound frame** against 0.075
on the HTTP path, and 77 ms of synchronous work per keystroke on a 320-block
document — of which **94% was not the disk** but `indexableBlocks` re-parsing the
whole document. Both fixed: the handler marks the document dirty, and the
reindex reads the parse `parsed()` already memoized on the version vector.

**Fan-out computed the same delta once per connection.** Since D33 every
connection's watermark advances on every change, so in steady state they are all
at the same version and the loop recomputed identical bytes N times: **×7.3 at
32 peers, ×15.6 at 64**. Grouped by watermark, one delta per distinct version.

**`maxOpenDocuments` bounded neither the peak nor the steady state.** Eviction
ran only as a side effect of an open, a concurrent caller returned immediately
instead of asking for another round, and a pass that ended still over the cap
simply stopped. A 128-way burst against a cap of 16 peaked at **127** and settled
at **79** — and stayed at 79 through three seconds of idle. Under sustained
thrash the population climbed every round, 44 → 115, and native memory climbed
with it, 44.5 → 82.5 MB. Two changes: a pass that loops until it is under the cap
or out of candidates, and an opener that **waits** for eviction once the
population passes a hard multiple of the cap, so opens cannot outrun closes. Now
peak 16, settled 16, thrash flat.

**`History` was bounded by count, not by bytes.** Every revision holds the
document's whole text — the right call for a scrubbable timeline — so 500 of them
was **493–498× the document**, and 256 documents open at once is over a gigabyte
of live strings behind a couple of megabytes of content. Now bounded by both,
with a floor so a large document still keeps a usable timeline.

**`listRevisions` returned the oldest window.** `ORDER BY ticket ASC LIMIT 200`,
so a document with more than 200 revisions rehydrated its *earliest* 200 and the
timeline showed ancient history and no recent edits. A correctness bug found by a
latency test measuring cold-open cost, which is the usual way.

**And the per-request `Deadline` was never consulted.** Constructed on every
request, disposed on every response, read by nothing: a run with a 1 ms budget
and a 33 ms p50 returned fifteen 200s and zero 504s. `requestBudgetMs` bounded
nothing while every request paid an `AbortController` and a timer for it. It now
gates the handler and the reply, which bounds what a single-threaded server can
actually bound: time spent *waiting*.

One more parse was removed on the way past. A mutation parses twice — once to
resolve the ops against the current bytes, once to segment the result — and
parsing is ~52 µs per block, the largest single term in an edit. The second parse
is now seeded into the version-keyed cache when reassembly reproduced the target
bytes exactly, so the *next* mutation gets it free. The string comparison that
guards it is what keeps a cache of bytes the document does not hold from becoming
a correctness bug.

End to end, on the same machine, before → after:

| measurement | before | after |
|---|---|---|
| `applyOps` p50 | 0.441 ms | 0.289 ms |
| comment p50 | 0.208 ms | 0.013 ms |
| read under a write storm, p50 | 61.5 ms | 34.5 ms |
| PATCH throughput at c=1 | 199 ops/s | 272 ops/s |
| PATCH p99 at c=64 | 600 ms | 425 ms |
| PATCH p50 with 32 subscribers | 10.1 ms | 7.4 ms |
| PATCH p99 with 32 subscribers | 16.1 ms | 9.2 ms |

---

## D36 — Two things the rounds found that are *not* fixed, and why

Recorded rather than quietly left, because both are architectural and a reader
deserves the numbers.

**An edit is one uninterruptible synchronous stall.** Time queued in the
`Sequencer` is 0.004–0.018 ms at every concurrency level — the sequencer has
never been the bottleneck — but the task it runs holds the event loop for the
whole edit: measured p99 event-loop stall 38.8 ms against a 39.4 ms request p50
on a 240-block document, and a 10 ms metronome losing 85 of 133 ticks under 48
concurrent PATCHes. `/v1/health`, which touches no document, no lock and no
sequencer, went from 0.23 ms to 49.9 ms p50. The cost is linear in document size
(~52 µs/block to parse, ~61 µs/block to splice) with a measured log-log slope of
0.98–1.02, so there is no superlinear term to remove — the fix is to chunk the
parse and splice so they yield, or to move them off-thread, and both are
structural changes rather than optimisations. A prototype yielding *between*
sequencer tasks moved nothing, which is the evidence that the stall is inside one
task.

The load-bearing corollary: every deadline in this system is a `setTimeout`, and
timer lag under load equals the longest synchronous stretch on the loop exactly.
No timeout in Galley has a resolution finer than one edit.

**Concurrent merges degrade a document permanently.** Sixteen peers editing the
same document in turn: `importUpdates` p50 flat at 0.045–0.050 ms over eight
rounds. The same sixteen peers editing *at the same instant*: 0.185 → 8.557 ms,
**46×**, with round wall time going 159 → 2596 ms for the same sixteen edits.
Persistence is flat throughout, so it is not storage; the snapshot grows from 4.5
to 10.6 KB with the block count unchanged, so it is un-compacted CRDT history.
Quiet does not help — after a storm the document sits at 1.35–1.7× its baseline
latency indefinitely. Throughput consequently peaks at one to two simultaneous
writers and *collapses* past it: 12× the offered concurrency delivers 0.17–0.18×
the throughput.

Nothing is lost while that happens — every replica converges, zero divergence,
zero disconnects, and correctness held under every load either round applied. The
fix is periodic history compaction, which changes what a version vector means to
a connected peer and therefore belongs with a resync protocol rather than in a
latency pass.

---

## D37 — Five engine defects, and one crash that only the fixes could expose

The last of the adversarial findings, cleared.

**An escaped pipe in a plain table cell was escaped twice.** The inline
serializer escaped it, then the table serializer escaped it again, producing a
literal backslash followed by a *bare* pipe. The next parse read that pipe as a
cell boundary: a body row silently grew a column, and a header row stopped
matching the delimiter row, which makes GFM drop the table to a paragraph. The
table serializer now escapes only a pipe the inline serializer emitted verbatim,
which is the one inside a code span.

**A line-start escape was applied wherever a run of inline content began.**
`**1. The first phase.**` became `**\1. The first phase.**` — and a backslash
before a digit is not an escape in CommonMark, so the reader simply saw the
backslash, and the next save escaped *that* backslash, one per save forever. It
fired on this repo's own design docs. `serializeInline` now takes the flag
explicitly: emphasis, strong, strikethrough, links, headings and table cells all
pass `false`, because each puts characters in front of its content, and a hard
break sets it back to true.

Fixing that exposed a second defect underneath it: even where the escape *was*
wanted, `\1.` is not how you escape an ordered-list marker. The backslash goes
before the delimiter — `1\.` — so the escape never worked and the backslash was
always visible.

**A marker left alone in a list item lost its block.** When every other inline is
removed, CommonMark reads the item's content as an html *block* rather than a
paragraph with an html child, so nothing claimed the id and `renderClean`
stopped stripping the comment: raw plumbing reached a reader. A marker with no
following block now belongs to the container that holds it — with its range
narrowed to the comment and the whitespace in front of it, because the `- ` is
the list's own syntax and deleting it with the marker removes the item. The
fuzzer caught that within one run, as a broken materialize/dematerialize inverse
on an empty list item.

Every corpus entry now reaches a byte-exact fixed point under forced full
re-serialization. The `DRIFTS` exemption list is empty.

**And a crash that could not happen while eviction was broken.** With eviction
fixed to actually run, the cross-document storm started dying with
`null pointer passed to rust`. `openDocument` hands the actor back to a caller
that works with it *outside* the workspace lock, so an eviction can land between
the two, and freeing the CRDT there turns the caller's next read into a hard
crash. An evicted document's memory is now freed after a grace period longer
than any request's budget. The first version of that leaked worse than the
original — a superseded grace timer was cancelled but its document never freed,
73 KB per open — which the memory test caught immediately.

**Sidecar writes had no error handler.** Comments, suggestions, orphans and
revisions are mirrored to storage from the actor's event feed with
`void store.transaction(...)`, so a disk failure became an unhandled rejection,
and Node's default policy for an unhandled rejection is to terminate the process.
A chaos run that failed four consecutive transactions surfaced it: the document
survived, the retry worked, and the server died anyway. A sidecar record that
cannot be written is now a counted loss.

---

## D38 — The chrome is a menu bar and a toolbar, not a `/` menu

**Context:** the product's premise is a writing surface for people who will
never type `**bold**`. The chrome it had was the opposite bet: a `/` menu, a
selection bubble, a "+" button, and a comment in `Editor.tsx` arguing that a
permanent toolbar "was spending permanent attention on rare actions."

That argument was wrong on the facts, and the reversal is worth recording
because the old reasoning was persuasive.

**The factual error.** The claim was that a toolbar is inert whenever the caret
is collapsed. It is not. Of the controls a word-processor toolbar carries, only
link and comment genuinely need a selection; the paragraph style, every list
button, both indents, undo, redo and clear-formatting all operate on the caret's
paragraph or on the document, and bold/italic/underline set stored marks for the
next character typed. The premise was inverted.

**The deeper error.** A toolbar's primary job is not invocation. It is
*advertisement and status* — it answers "what can this thing do?" and "what am I
in right now?", and it answers both without being asked. A control that only
appears on selection cannot do either, because it is absent exactly when someone
is looking around wondering what the program is.

**The evidence, which is unusually direct.** The designer who shipped Dropbox
Paper's slash commands published a teardown of them finding two distinct
failures: an *awareness* problem (people did not know the commands existed) and
a *usability* problem (people who knew did not know how to use them). The fix
Dropbox tried — an inline "type / to quick add" hint at the cursor — drew
complaints that it interrupted writing. That is the trap in one move: **teaching
a hidden affordance destroys the calm that justified hiding it.** A persistent
toolbar is the only teaching mechanism that does not intrude on the text,
because it does not live in the text.

Two cross-checks kept this from being over-claimed. Craft and Coda have nearly
identical chrome — no persistent bar, a `/` menu, a selection bubble — and sit at
opposite ends of every approachability comparison, so visible chrome is not
sufficient on its own; conceptual surface area dominates. Galley's conceptual
surface is small (it is a document with paragraphs), which means discoverability
is the whole fight here, and it is a much cheaper one than Notion's.

**Decision:**

- **A menu bar.** Everything the app can do is enumerated in it, in plain
  English, with its shortcut shown — which is where most people ever learn a
  shortcut. The toolbar is a shortcut *to* this list, never a superset of it: a
  control the toolbar has and the menus do not is a control that cannot be found
  by looking.
- **A persistent toolbar.** Same order every time. A control that cannot apply
  is greyed rather than removed, because a row whose buttons come and go is a row
  you cannot build muscle memory against. The greying is honest — it comes from
  asking each ProseMirror command, with no dispatcher, whether it *could* run,
  which is the command's own applicability answer rather than a second guess at
  it.
- **Overflow is measured, not media-queried.** The space available to the
  toolbar depends on whether the document list is open, which no viewport
  breakpoint can see. A `ResizeObserver` on the bar decides how many groups fit;
  undo and the style menu never collapse.
- **One thing still hangs off the selection:** a comment button, in the margin,
  where it covers nothing. That is what Google Docs does, and the restraint is
  the point — a popup over the words you just selected covers the thing you are
  looking at.

**Consequence:** `slash.ts` is deleted, and the placeholder text no longer
advertises a key. `corePlugins` no longer takes a `slash` plugin. Two e2e tests
that asserted the *absence* of a toolbar were inverted to assert its presence,
which is the honest way to record a reversal in a test suite.

---

## D39 — A real page, at real dimensions

**Decision:** the page is 816px wide with 96px margins — US Letter at 96dpi, one
inch — with square corners, a hairline edge and a 3px contact shadow. It was a
`clamp(880px, 62vw, 1060px)` fluid column with a 16px radius and a 28px ambient
blur.

**Why a fixed page rather than a maximum.** A fixed page is a *shared coordinate
system*. "Halfway down page 3" and "the third line of the second paragraph" mean
the same thing to two people on different monitors; a fluid column has no such
vocabulary, and the line-break positions it produces are a property of the
reader's window rather than of the document. That is also why Google shipped its
pageless mode as an opt-in subset rather than a replacement — going pageless
costs page numbers, headers, footers and columns, and they could not offer it as
a superset.

The existing comment defending the fluid width — "a wider page would only buy a
longer line, which is the one dimension readability does not want" — is a good
argument for a *maximum* and no argument at all against a fixed value.

**Why the desk cooled.** It was `#eae7e0`, a warm beige. It is a nicer colour and
the wrong signal: a tinted desk reads as *a designed surface* and competes with
the paper rather than holding it. Near-neutral leaves the page as the only object
on screen with intent. The shadow changed for the same reason — a 28px ambient
blur is an elevated card, and paper on a desk has an edge and a contact shadow.

**Consequence:** the margin's breakpoint stopped being taste and became
arithmetic — paper, plus the spread's padding, plus the gap, plus the narrowest a
note card can be and still hold a sentence. The old threshold let the desk
scroll sideways at 1280px, which the width test caught.

---

## D40 — A diagram is a fence, and mermaid is guarded three ways

**Decision:** a fenced block whose info string names a diagram language loads as
a `diagram` node — an atom holding its source — and serializes back to the same
fence. The allowlist has one entry, `mermaid`, and the rule for adding to it is
strict: **only a language the rest of the world already draws.** A language that
GitHub shows as source and Galley shows as a picture would be the WYSIWYG lying
about the file.

**The three guards, and why all three.** Mermaid's default failure mode is to
draw its own "Syntax error" graphic straight into the live DOM, outside anything
it was handed. Inside ProseMirror that is not cosmetic: the view's
`MutationObserver` sees foreign nodes appear inside the editor and either parses
them into the document or throws — so a half-typed diagram could corrupt a
writer's file. Each of these is individually sufficient, and all three are
present because any one is a config regression away from being absent:

1. `suppressErrorRendering: true`, so failure never touches the page.
2. `parse(..., { suppressErrors: true })` before `render`, which returns `false`
   rather than throwing and appends nothing anywhere.
3. `ignoreMutation` on the NodeView, so nothing under the SVG is read back.

Alongside them: `securityLevel: 'strict'` with a `>= 11.10` floor, because a 2025
advisory showed strict was bypassable before it and the source arrives from
agents; a silenced global `parseError` hook, because a writer's typo is not a
program error; a render generation counter plus an `isConnected` check, so a slow
render that lost the race cannot paint; a cache keyed on **theme as well as
source**, because mermaid bakes colours into its SVG; and a dynamic import, so a
document with no diagram pays nothing.

**A failed diagram shows its own source and a plain-English sentence, never a red
box.** The document is never wrong — only the picture is unavailable.

**And the bug this work found.** `nodeToFlow` hardcoded a fence's `meta` to
`null` while the parser and the serializer had both always carried it, so editing
```` ```ts title="server.ts" ```` silently deleted the tail. That is precisely the
"silently disappears on save" failure `schema.ts`'s own header warns about, and
it was live on `main`.

---

## D41 — Underline and highlight are inline HTML, and that is not an extension

CommonMark has no syntax for either. Both round-trip as `<u>…</u>` and
`<mark>…</mark>` — the inline HTML the spec itself permits, which renders
correctly in every HTML-producing renderer and degrades to visible text in none.

They exist because **the toolbar is the product's promise.** A writer coming
from a word processor reaches for underline and for the yellow marker, and a
toolbar missing both is the tell that this is a Markdown editor wearing a
costume.

mdast hands these back as three flat siblings — an `html` open tag, the content,
an `html` close tag — so the pairing is folded into a mark before the ordinary
inline walk, and `wrapMark` returns a *list* rather than a node. An unbalanced
tag is left as a raw atom rather than guessed at, and the allowlist is two
elements long: anything with attributes, or whose meaning depends on where it
sits, stays raw and is re-emitted verbatim.

The cost — two constructs an agent reads as HTML rather than as Markdown — is in
`tradeoffs.md`, along with the four controls that are *absent* for the same
reason and could not be made to pay it.

---

## D42 — A design is a web page with the cascade removed

**Context:** "an agent-native, agent-readable Figma." The whole feature rests on
one decision — what a design's source of truth is — so that is where the
thinking went.

**Decision:** a design is a small tree of boxes, text and images, laid out by
flexbox, in which every node carries its complete style inline as a **closed set
of utility class names** and every value comes from a named scale. No selectors,
no cascade, no stylesheet.

**Four properties follow, in the order they matter:**

1. **An edit is local.** Changing one layer changes one line — the precondition
   for the same splicing guarantee the prose engine makes. This is why
   unrestricted HTML+CSS lost: with a cascade, the effect of an edit depends on
   the whole document, and a GUI change to a class silently changes every node
   matching it.
2. **A model can write it.** The measured gap between a semantic format and raw
   coordinates is large and consistent. On VGBench, GPT-4 scored 54.9% authoring
   SVG against 81.0% on TikZ, the paper's own explanation being that SVG is
   low-level geometry while the others carry high-level constructs. SVGenius then
   showed the same models collapsing from ~80% to ~33% as a drawing passes
   sixteen paths. Sixteen paths is a button group.
3. **Nothing in the pipeline measures text.** Advance width is a property of the
   font file and a model cannot know it — so the format never asks. It says "a
   column with a gap" and the browser does the arithmetic. This is also why flow
   layout is the only layout: there is no way to store a coordinate, so a mouse
   cannot produce one.
4. **It degrades.** The markup is legible in any renderer, which is Principle IV
   holding for a picture.

**The closure is the feature.** There is no syntax for a literal colour, so the
characteristic failure of a machine-written design — a blue that is *almost* the
brand blue — cannot be expressed. An unknown class is an error carrying the fix,
never a silent drop: a design that ignored what it did not understand would look
different in the editor and in the export.

**A design is its own document** whose body is a single ```` ```design ```` fence.
That buys identity, history, comments, suggestions and a CLI read path for free,
because all of those already work for documents, and it means the storage layer
learned nothing new. A prose document points at one with an ordinary CommonMark
link — a link everywhere else, a live embed here. See `tradeoffs.md` for the
`.design.html` sibling this diverges from.

**The parser is hand-written and strict**, deliberately: it runs in Node for the
CLI, and a browser parser is *specified* to recover from anything, which is
exactly wrong for a format whose value is that an unknown construct is reported
rather than dropped.

**The linter runs in the loop, not as a report.** Every rule catches something a
model gets wrong and a person does not — invented values, an image with no
description, alignment classes on a box that is not a row, two layers claiming
one id. A linter whose output nobody reads is a slower way of shipping the same
bug.

**The agent surface has three read tiers and the cheapest exists on day one.**
`galley design outline` is structure without styling. That ordering is the lesson
from Figma's MCP server, which shipped a sparse representation only after users
reported a 351,378-token response from the full one. `galley design classes`
takes no reference at all, because the tool serving its own grammar is the
defence against a model confidently inventing class names that do not exist.

---

## D43 — A ticket names one mutation, so `History` refuses to record it twice

`History.adopt` replayed every persisted revision unconditionally, so rehydrating
a document that was already warm recorded each of its revisions a second time.
The timeline showed one moment twice, two rows claimed the same restore target,
and `at(ticket)` was free to answer with either.

A ticket is the sequencer's identifier for one mutation, so two revisions sharing
one has no correct interpretation — the only question is whether the duplicate is
dropped at the boundary or corrupts everything downstream. `record` now ignores a
ticket it already holds. The set of seen tickets is deliberately *not* pruned
when eviction drops a revision: an evicted revision that came back would be a
duplicate too.

Found by the "logs no console errors" e2e test, which failed only in a full run —
the earlier tests are what accumulated enough revisions for a rehydration to
happen at all.

---

## D44 — What three adversarial reviews found, and the one lesson worth keeping

Three reviewers were pointed at the chrome, the diagram work and the design
editor, with instructions to verify every claim before reporting it. They
returned roughly forty defects. The suite was green throughout.

**The single most useful sentence in the three reports** was about the design
package: *"the test suite passed all 24 of its assertions against inputs
written to satisfy it."* Every test had been written by the same person who
wrote the code, minutes later, from the same mental model — so the tests covered
the format and did not attack it. Attacking is a different activity, and it is
the one that found:

- an attribute value containing `>` silently destroying a layer's name,
- `String.fromCodePoint` throwing out of a React render *and* a ProseMirror
  `decorations()` call, so one bad entity in a design took down every prose
  document that linked to it,
- a nested `<frame>` being hoisted to the top and emitted first, reordering
  frames on save.

All three returned `ok: true`.

**The worst defect was in code written hours earlier.** Bolding a phrase and
then highlighting one word of it destroyed the emphasis — not on save, but on
the save *after* that, because the first one produced `** plain**`, which is not
left-flanking, and the second escaped the asterisks. The existing test covered
the case where the HTML mark was outermost, which is the case that works. The
fix is in D41's neighbourhood: the widest run wins, and the mark table is only a
tie-break.

**Three things were broken in ways no test could have caught, only a browser:**
the style dropdown and the toolbar overflow menu were both rendered, invisible
and unclickable behind `overflow: hidden`; the menu bar listened for
`pointerdown` and so could not be opened by a keyboard at all, while asserting
`role="menubar"`, which tells a screen-reader user to press arrow keys that did
nothing; and the design editor's controlled inputs were reverted by React on
every keystroke, so exactly one character survived per save round-trip.

**Four shortcuts the menus advertised were bound to something else or to
nothing.** That is a category of bug a reviewer finds and a test suite does not,
because nobody writes a test asserting that a label is true. The structural fix
was to delete the third copy of the list: the keymap is derived from the same
specs the toolbar and the menus are drawn from, so the glyph a menu prints *is*
the binding.

**What to do with this.** Two habits, both cheap:

1. **After writing tests for a format, attack it.** Not more of the same tests —
   deliberately hostile input, written by someone who did not write the parser.
2. **Anything with a popup, a keyboard contract or a controlled input has to be
   driven in a browser before it is believed.** Six of the worst findings were
   invisible to `tsc`, to 600 unit tests, and to a screenshot.

---

## D45 — The second review, and the shape a fix takes when it is wrong

The three round-one reviewers found ~40 defects. A fourth was then pointed at
the *fixes*, told to prove each one and to find what round one missed. It
verified six of nine as correct — the toolbar's measured-width overflow was
exercised across 102 container widths, a 2px sweep across the collapse boundary
in both directions, and 120 rapid alternations, with zero residual DOM mutations
at every sample — and found fourteen more defects.

**The pattern in almost all of them: the guard was right and its assumption was
not.**

- `pathOf` skipped the first entry on the stack *assuming* it was the `<design>`
  wrapper. A fragment without one gave a frame and its first child the same id.
- The nesting refusal checked for a `<design>` *inside* a `<design>` and not for
  one *beside* it, so two siblings merged into one named after the second.
- "Words belong in a `<text>`" only fired when there was something to be inside
  of, so words outside the design entirely were dropped in silence.
- The menu bar's focus effect keyed on `openId`, *assuming* that a request to
  enter a menu meant the menu was changing. Arrowing into one that was already
  open set the same value, React bailed, and the effect never ran — an open,
  visible, completely keyboard-dead menu.

The lesson is narrower than "test more". Each of these was a **guard written
against the case that prompted it**, generalised by hope rather than by
argument. The three that took three attempts each are the same story told
loudest:

**A mark against a delimiter took three commits.** First `**a **` from a
*partial* overlap; then the same shape from *crossing* marks; then again from a
**hard break**, which serializes as two spaces and a newline and is therefore
whitespace that does not look like whitespace. The first two fixes trimmed
spaces. Only the third asked the right question — *what cannot sit against a
delimiter?* — and the answer is a class, not a character.

**Two things worth carrying forward:**

1. **When a fix names a case, ask what class the case belongs to.** "Trim
   trailing spaces" is a case. "Nothing that CommonMark's flanking rules
   disqualify may touch a delimiter" is the class, and it was reachable on the
   first attempt by reading the spec rather than the failing example.
2. **Review the fixes, not just the code.** Six of nine held; three did not, and
   two of those three were *worse* than what they replaced in some path. A fix
   is a change like any other and deserves the same suspicion.

A methodological note, because it cost real time: `apps/web/src/editor/diagram.ts`
contained a literal NUL byte in a cache-key separator, which makes `grep -r`
treat the file as binary and skip it entirely. A reviewer concluded a listener
was never wired because the grep came back empty. It was wired. Never put a raw
NUL in a source file.

---

## D46 — The canvas: what a click means, and what a drag can produce

Two decisions carry the design canvas, and both are about refusing to let the
mouse say things the file cannot store.

**A drag produces a `(parent, index)` pair, never a position.** Every visual
builder that targets CSS converged on this independently — Webstudio, GrapesJS,
Plasmic, Onlook, Craft.js, Puck. Galley resolves it more cheaply than any of
them for one reason: *the layout axis is in the document*. `flex-col` and
`flex-row` are classes, so "which way do these children run" is a lookup.
Webstudio spends about 380 lines inferring the same fact from rect geometry,
with a `"mixed"` fallback, a diagonal test, and a DOM probe that inserts an
empty div to see which dimension collapses.

The rest of the drag is three borrowed constants and one rule:

- **The outer band of every box belongs to its parent** (6 screen px, Puck's
  inset). This single rule answers "into this box, or next to it" at every
  depth without a special case. Craft.js does the mirror image with a 10px
  *outset*; the inset composes and the outset does not.
- **The midpoint is biased in the direction of travel** (5%), or a hand resting
  on a boundary flips the answer on sign noise every frame.
- **Direction is measured over a window** (10px, Puck's `INTERVAL_SENSITIVITY`),
  because a frame-to-frame delta *is* the noise.
- **A changed slot is what causes a redraw**, not a moved pointer. Recomputing
  is cheap; committing is a parse and a serialize.

**A click selects the child of the container you are inside.** The focus model:
Figma's *focus*, Sketch's *group entering*, Illustrator's *isolation mode*,
Webflow's breadcrumb. The two alternatives are both common and both worse —
innermost makes a container ungrabbable without the layer tree, outermost makes
nesting unusable. Double-click enters, Escape leaves, and every transition has
an obvious inverse.

**With one exception that the canvas argued for: a frame is transparent.** It is
an artboard, not a group. Making it opaque meant a double-click before every
first edit, every time, to reach a level nobody thinks of as nested. Figma draws
exactly this line between frames and groups, and it is worth copying exactly.

Multi-select is **siblings-only by construction** rather than by disabling the
toolbar afterwards. Reorder, align, distribute and wrap are all operations on a
child list, so a selection spanning parents is one most gestures would have to
refuse; cheaper to make it unrepresentable.

## D47 — Chrome goes on an overlay, before the handles rather than after

Selection outlines, the hover hint, the focus ring, the drop indicator and the
marquee are one SVG on top of the design, in viewport space. Drawing them as CSS
on the layers themselves — which is what shipped first — is wrong in three ways
that only appear once there is a zoom:

1. Chrome inside the transform **scales with it**. A 2px ring is half a pixel at
   50% and eight at 400%.
2. An outline on a layer **changes what the ResizeObserver reports**, so a
   measurement moves because something got selected. That is a feedback loop.
3. A drop indicator **has nowhere to live**: it belongs between two children,
   and that is not a place any element is.

Build the overlay before the handles. Everything drawn on it is constant screen
size for free; retrofitting means rewriting all of them.

The stage is **bounded, and there is no dot grid**. An infinite canvas is the
right shape when contents have arbitrary positions; here they cannot. A grid is
a coordinate affordance and there are no coordinates — drawing one would be a
lie about what a drag does.

## D48 — Three things the browser found that no unit test would have

All three are the same shape: a thing that was *visible and completely inert*.

- **Pointer capture retargets clicks.** A drag must capture the pointer or the
  gesture dies the moment it leaves the element — and capture then makes the
  browser retarget every later `click` and `dblclick` at the capturing element.
  Reading `event.target` turned every double-click into a silent no-op. Hit
  testing is from the point now.
- **The zoom controls float inside the stage**, so the stage captured their
  pointer and the buttons were visible, hoverable and dead.
- **A move op asked the old design what is at the slot**, so a drag that
  succeeded left nothing selected. Positional ids have to be read from the
  design that comes *back*.

The lesson is the one D44 already recorded, in a new place: an affordance that
appears and does nothing is the failure this codebase keeps finding in its own
work. Two of these three were only reachable through a real browser, because a
jsdom test has no pointer capture and no compositor.

## D49 — Fixed, Hug, Fill; and arrows reorder rather than nudge

The inspector's size control uses Figma's three words, borrowed exactly: every
designer already knows them, and all three are expressible here — *hug* is the
flexbox default, *fill* is `grow` along the flow and `self-stretch` across it,
*fixed* is the one place this format admits a raw pixel. "Fill" resolving to two
different classes depending on the parent is not a leak; it is why the control
has to know which way the parent runs. A lone `grow` on the cross axis does
nothing at all, silently.

Arrow keys **reorder**. Nudging is a coordinate gesture and there are no
coordinates, so an arrow that moved a layer by a pixel would have nowhere to
write the pixel down. Across the flow they do nothing rather than something
arbitrary: in a row, up and down have no order to express.

## D50 — An agent changes a design by sending ops, and the answer is "no worse"

The write path is `galley design apply <path> --ops <file|->`, and its shape is
the point: the ops are the same eight the canvas produces when someone drags a
box, and what comes out is an **ordinary block-scoped suggestion**. Review,
attribution and history are the ones prose already has. There is no second code
path to drift.

Three gates, and the middle one is the entire argument for having an op
vocabulary rather than a text patch:

1. **Is this an op at all** — shape, types, ranges, decided before the document
   is read. Every message names the op's position and what was expected, because
   the reader is a model that will try again, and "invalid input" guarantees the
   second attempt is another guess.
2. **Would applying it break something?** Not "is the design clean". A design
   that already has four contrast failures must still be editable, and blaming
   an agent for the other three is how a safety check becomes the thing everyone
   turns off. The bar is *did this change make it worse* — which is a question
   you cannot ask a text patch at all.
3. **Is it small enough to read as a change** rather than as a replacement. A
   delete costs its whole subtree, so a rewrite cannot hide behind a small op
   count. Half the layers is the line.

It also reports what the change **fixed**, which is the half a diff never shows:
nobody reading eleven class swaps can see that one of them took a label from
2.9:1 to 7:1.

One thing the border refuses that the linter only warns about: an **inserted**
image with no description. A warning is right for something already in the file;
an image being added right now with no alt is a hole nobody will come back and
fill, and the description is the only part of it the next agent can read.

## D51 — The typecheck did not check the application

Found while fixing the canvas: the root TypeScript project referenced every
package and **not `apps/web`**. The entire user interface compiled only through
Vite, which does not typecheck. Two undefined identifiers reached a running
browser in a single session; both were caught by a person looking at a blank
page, which is the most expensive way to find a `ReferenceError`.

The reference is added and the three errors it surfaced are fixed. The rest of
the application was already clean, which is the only reassuring part — but the
lesson is that a green `typecheck` is a claim about *what it was pointed at*,
and nobody had checked what that was.

Cost of the omission, in one line: build output under `apps/web/dist-types` is
tracked in git and now regenerates on every build. Worth untracking, and out of
scope for the change that found it.
