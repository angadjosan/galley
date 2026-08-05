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
