# Tradeoffs

Decisions considered but not taken, and open forks. A log — append, don't rewrite.

---

## Local file: live projection vs. checkout

**Status:** open. `idea.md` currently specs the projection model. The checkout model is the likely replacement but hasn't been applied.

### The question

Does a document need to live locally *and* be edited live in Galley, or is the cloud the only home with local as a derived copy?

`galley pull` already gives local files. So the fork isn't cloud vs. local — it's whether the local copy is a **live projection** or a **checkout**.

### Option A — live projection (what idea.md specs today)

The file is continuously written by the projection writer. An fs watcher diffs external edits against the projection and applies them as inbound ops. One law holds it together: *the CRDT is the source of truth, the file is a projection, no merge dialog ever.*

**Buys:** edits made in a local editor appear in a collaborator's browser in real time. Genuine "one document, two surfaces."

**Costs:** nearly all the engineering risk in the product. The fs watcher, atomic-save detection (write-temp-and-rename shows up as delete+create, not modify), partial writes, symlinks, file deleted mid-session, offline reconciliation, and the `git checkout` case — where a whole-file replacement diffs as an enormous inbound op set and silently rewrites the document under everyone editing it. That last one needs a magnitude rule bolted onto the law to avoid eating a user's work.

### Option B — checkout

```
galley pull ./docs     # files land locally; agents and editors work on them freely
galley push            # local edits go back
galley status          # what drifted, in both directions
```

The local copy is a checkout, not a peer. No watcher, no live reconciliation.

**The move that makes this better rather than merely cheaper:** a local edit that arrives after the cloud doc moved on is *a suggestion*. That primitive already exists — anchor, replacement content, author, `pending`/`stale` state, review UI. Conflict resolution stops being a subsystem and becomes an existing feature with a different author field. `galley push` creates suggestions; a human reviews them exactly like an agent's.

**Deletes:** fs watcher · projection writer as a live component · the filesystem event table · external-edits-as-inbound-ops · the branch-switch magnitude rule · offline reconciliation. Open problem #1 in `idea.md` (docs living on several git branches at once) largely evaporates too — a branch is a checkout that hasn't been pushed.

**Survives unchanged:** the splicing serializer, which is still P0 — pull and push must not reformat the file. Block identity. Multiplayer, which now only has to work browser-to-browser, the case Loro handles for free.

**Costs:** "I edit locally and my colleague watches it change in their browser" goes away.

### The test that decides it

Prompt iteration — the one workflow that genuinely requires local access. You edit a prompt in your editor, run the agent, edit again, ten times in two minutes.

Live projection buys nothing there. You're the only person touching the file, and nobody's browser needs to see keystroke 400 of a loop that finishes in ninety seconds. Live projection is solving multiplayer-across-the-filesystem, which is a demo rather than a workflow.

### Leaning

Option B. Cloud is the home, local is a checkout. The lost capability is worth less than the deleted risk surface, and the build order improves: step 1 stops being "survive the filesystem" and becomes just the round-trip engine.

### Consequences to design for if B is taken

- **Path mapping is required, not optional.** Prompts and `CLAUDE.md` must land at a specific path for an agent to auto-load them, so `pull` needs an explicit doc→path map rather than dumping into a folder.
- **Staleness becomes the whole local UX.** A teammate edits a prompt in the browser and your local copy is stale until you pull. That's git's model, which engineers already have intuitions for — `galley status` carries it.

---

## Branch variants: fork the doc, or diverge and review

**Status:** decided (`idea.md` v0.3, hard question #1). Recorded here because the rejected option keeps looking attractive.

**Taken:** one canonical version per doc identity. A branch variant is a *divergence*, and editing a diverged file produces suggestions against canonical.

**Rejected:** per-branch doc variants, where the same `galley:` identity carries N versions keyed by ref. Genuinely better for the narrow case of a doc rewritten in lockstep with a long-lived feature branch — but it splits the comment ecosystem across variants, and an annotation layer whose comments are in the other branch is worth nothing. It also drags git vocabulary into a product that spent a whole principle avoiding it.

**Notes:** the decision is cheaper still under Option B above — a branch is just a checkout that hasn't been pushed, and the divergence path is the push path. If B is taken, this entry costs nothing; if A is kept, it costs the diverged-file state in the filesystem event table.

---

## Concurrency primitives: off-the-shelf vs. built here

**Status:** decided (built here). See `decisions.md` D2.

**Taken:** `@galley/concurrency`, written before any product code.

**Rejected:** `async-mutex` + `p-queue` + `opossum`. They are good libraries and
would have saved a day. Three properties decided against them, all of which the
stress suite has to be able to assert on:

1. **Fairness as a guarantee, not an implementation detail.** The suite asserts
   strict FIFO handoff. A library that happens to be FIFO today can stop being
   FIFO in a patch release, and the failure mode — the projection writer starved
   by a hot editor, so a document "saves" and never reaches disk — is invisible
   until it is a support ticket.
2. **Cancellation-safe acquire.** A waiter that aborts in the same turn the lock
   is handed to it must release rather than strand it. Most implementations
   either lack `AbortSignal` support or leak the lock on that exact interleaving,
   which is the one a disconnecting WebSocket client produces constantly.
3. **Close distinct from fault.** No off-the-shelf async queue distinguishes "the
   producer finished" from "the producer died", and Galley's consumers must
   commit in the first case and roll back in the second.

**Cost accepted:** ~1,100 lines to own and 117 tests to keep green.

---

## Latency assertions in CI

**Status:** decided (measure and print, assert only on generous ceilings).

Absolute latency numbers are a function of the machine, not the code. The stress
suite records exact percentiles and prints them, but hard assertions are reserved
for properties that hold on any machine: no unbounded queue growth, no lost
event, no ordering violation, and completion inside a timeout that a genuine
deadlock would blow through by orders of magnitude.

**Rejected:** asserting `p99 < 5ms` in CI. It passes on a quiet laptop and fails
on a loaded runner, which trains everyone to ignore the suite — the single most
expensive thing that can happen to a test suite.

---

## Normalization scope: minimal vs. canonical

**Status:** decided (minimal). See `decisions.md`; implemented in
`packages/markdown/src/normalize.ts`.

**Taken:** first ingest touches only things that are ambiguous *to tools*:
trailing whitespace that is not a hard break, leading tabs (which silently
decide list nesting), mixed line endings, a missing final newline, and trailing
blank lines. Everything else is left exactly as written.

**Rejected:** canonicalizing on ingest — one bullet character, one emphasis
marker, one heading style, uniform table padding. It is genuinely tempting: a
canonical corpus makes the serializer's job trivial and every later diff
smaller.

It was rejected because it converts the one-time, agreed-to cost of ingest into
a *large* one-time cost. "Connect this folder" would produce a diff touching
every line of every file, which no team will accept on a repo their code lives
in — and the first impression of the product would be a reformatting bot. The
minimal set fits in a review dialog a person can actually read.

**Consequence:** the serializer has to detect and reproduce each document's own
conventions (`style.ts`), which is more code than a canonical serializer would
need. That code is cheap and testable; a refused install is not.

---

## Marker placement: above the block vs. trailing inline

**Status:** decided (trailing inline). Recorded because the rejected option is
what `idea.md` implies and what anyone would reach for first.

**Rejected:** `<!-- ^a1b2c3 -->` on its own line above the block. It splits a
tight list in two, because an HTML block between two list items ends the list.
The cost of discovering this late would have been high: every annotated list in
every customer document silently restructured.

**Taken:** appended inline at the end of the block. Full reasoning in
`decisions.md` D5, including the capability it gives up — only paragraphs and
headings can carry a materialized id.

---

## Editor: soft line breaks in an edited block

**Status:** decided (fold them). Recorded because it is a visible behaviour
change and the alternative is defensible.

**Taken:** an edited block's hard-wrapped source is reflowed onto one line.
Untouched blocks keep their wrapping exactly, because they are re-emitted from
their stored bytes.

**Rejected:** preserving the author's wrap columns through an edit. It requires
guessing where the wrap points *should* now be, which is a reformatting decision
made on the author's behalf — precisely what the round-trip engine refuses to do
everywhere else. A reflowed paragraph is a one-line diff on a paragraph the user
just edited; a re-wrapped one is a multi-line diff they did not ask for.

**Consequence:** teams that hard-wrap prose at 80 columns will see edited
paragraphs become long lines. If that turns out to matter, the fix is a
per-workspace wrap width applied only to blocks the editor already rewrote —
which stays inside the rule, since those bytes were being regenerated anyway.

---

## The browser and the CRDT

**Status:** decided (refetch on change; the CRDT stays server-side for now).

**Taken:** the WebSocket carries CRDT deltas, and the browser client currently
uses them only as a signal to refetch the document. Concurrent editing converges
because the *server* is the one applying operations in a defined order.

**Rejected for now:** applying Loro deltas in the browser and rendering from a
local replica. That is the right long-term shape — it is why the wire protocol
already carries deltas rather than snapshots — but it moves the merge into the
surface whose failure mode is *a document that looks fine and is wrong*, and
correct-and-simple beats clever there for a first version.

**Cost accepted:** a remote change costs a refetch rather than a delta apply, and
a local edit made during someone else's keystroke is resolved by the server
rather than locally. Both are invisible at the latency the sync path actually
runs at, and both become better rather than different when the local replica
lands.

---

## Validating inbound CRDT updates: trust versus a snapshot round trip

**Status:** decided (validate). See `decisions.md` D29.

**Taken:** every inbound `update` frame is applied to a throwaway copy of the
document and checked — does the document still know which document it is? — and
only then applied for real.

**Rejected:** trusting the connection. The client authenticated, and it has
write access to *this* document, so the reasoning goes that its operations are
its own business. That reasoning is wrong in one specific way: a client with
write access to document A can send A's operations on B's socket, and CRDT
operations from a different document merge without complaint because both use
the same container names. The result parses, so nothing downstream notices.

**Cost accepted:** a snapshot round trip per inbound update. Measurable, and
cheap next to a document that quietly claims a foreign identity.

**Better later:** Loro exposes enough to check the incoming ops' container ids
directly, which would make this O(update) rather than O(document). Worth doing
when the sync path is next touched; not worth blocking correctness on now.
