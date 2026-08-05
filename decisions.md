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
