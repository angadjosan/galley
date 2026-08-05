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
