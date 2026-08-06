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

---

## Freeing an evicted document promptly vs. never freeing it under a live caller

`openDocument` hands an actor back to a caller that then works with it outside
the workspace lock, so an eviction can land in between. Freeing the CRDT there
is a hard crash, not a slow path.

The fork not taken was reference counting: increment on open, decrement when the
caller is done. It is the exact answer, and it puts a release obligation on every
caller — the HTTP routes, the sync handler, the CLI, and every test that reaches
into the workspace directly. One missed release pins a document forever, and the
failure is silent.

What is here instead is a grace period longer than any request's budget. It is
less precise: memory is held for a bounded interval after eviction rather than
released immediately. It has no obligation to forget. Given that the population
of open documents is now genuinely capped, the interval bounds the overshoot to
something small and measurable, and the memory test asserts it.

## An empty exemption list vs. deleting the mechanism

`DRIFTS` — the set of corpus entries exempted from the re-serialization
fixed-point check — is empty and still there, typed as `Set<string>`. The
tempting cleanup is to delete it and the `it.fails` block that consumes it.

Keeping it is deliberate. The list was written as explicit names rather than a
predicate precisely so that fixing an entry turns the file into a lie loudly, and
that is what happened three times. An empty named set is the place a future
exemption has to be written down and justified. A deleted one is an invitation to
quietly loosen the assertion instead.

## Best-of-three on a tail-ratio assertion vs. a looser bound

`p99/p50 < 25` on the write path is a real property: a disproportionate tail
means a queue. Under the full stress suite, whose files run in parallel, a single
unlucky window of CPU contention lands entirely in the p99 and moves the ratio
further than any regression would.

Raising the bound would have made the assertion pass and stop meaning anything.
Taking the best of three rounds keeps it strict — a genuine queue shows up in
every round — at the cost of up to three times the samples on an unlucky run.
The alternative of pinning the suite to serial execution was rejected: the
contention is realistic, and the suite's wall time is a feature.

---

## The four toolbar controls that are not there

A Google Docs–shaped toolbar contains controls CommonMark cannot store. The
tension is not vague — it is exactly this wide:

| Control | Storable? |
|---|---|
| Bold, italic, strikethrough, code, links, lists, headings, tables, quote, rule, images | native Markdown |
| Underline, highlight | inline HTML the spec permits — **shipped**, see `decisions.md` D41 |
| **Font family, font size, text colour, paragraph alignment** | nothing |

The four in the last row are the ones a Google Docs user will look for and not
find, and they are absent for one reason: the button would either lie or destroy
the setting on the next save. A control that produces something the serializer
cannot express is a control that silently deletes work, which is the failure
`schema.ts`'s header exists to prevent.

**The fork not taken, and it is a real one.** These could live in the *sidecar*,
as per-block presentation keyed by block id — the machinery already exists, every
node already carries a `blockId`, and the `.md` would stay pristine. Opening the
file elsewhere would lose presentation and never content, which is a defensible
line. It is genuinely the strongest available answer, and it is a genuine
advantage over both competitors: Notion cannot give you clean Markdown, Google
Docs cannot give you a stable file, and block identity is exactly the mechanism
that lets Galley have a word-processor toolbar over a clean one.

It is not built because it is a *second* place presentation lives, and every
consumer — the CLI, `galley pull`, an agent reading the file, another editor —
would then see a document that is missing something the app shows. "The file is
the payload" is the product's first claim, and a sidecar that carries layout
weakens it in a way that only shows up later. Revisit when someone asks for
centred text twice.

What must *not* happen in the meantime: `<span style="color:#c00">` in the
Markdown. That is the walled garden Principle IV names, and it is the reason the
underline and highlight allowlist is two elements long and closed.

---

## Diagrams: an atom holding source, vs. a code block with two view modes

The researched recommendation was to keep a diagram as the existing `code_block`
node and switch its NodeView between "drawing" and "source" depending on where
the selection is. The argument for it is strong and mostly correct: no new node
type, no special-casing in `flowToNode`/`nodeToFlow`, and — the real prize —
agent suggestions, comments and the `suggestion` mark keep working *inside* a
diagram's source with no extra code, because the source is still text content in
the document.

What shipped instead is a separate `diagram` atom holding its source in an
attribute, edited in a panel.

**Why:** an atom cannot be half-typed into an unparseable state by a stray
keystroke on the canvas, and the panel can offer what a text surface cannot — a
gallery of finished diagrams to start from, a live preview, and a plain-English
sentence when the source does not draw. For the writer this product is for, "here
are six diagrams, pick one and rename the boxes" is a different proposition from
"here is a text box, learn a grammar."

**What is actually lost, stated plainly:** a comment cannot be anchored to a line
*inside* a diagram, and an agent cannot suggest a two-line change to one — it
proposes the block. Both are real, and both are smaller than they sound: a
diagram is a single figure, and a note on it is a note on the figure.

**What would flip this:** the first time someone wants to review a diagram's
source the way they review a paragraph. The dual-mode design is the answer then,
and the round-trip is identical either way, so the change is confined to the
editor.

---

## The design format: a `.design.html` sibling vs. a design *document*

The researched recommendation was that a design live in its own
`checkout-payment.design.html` file next to the prose, referenced by an
image-inside-a-link so that every CommonMark renderer shows a picture and a click
reaches the source.

What shipped is a design as its own **Galley document** whose body is a single
```` ```design ```` fence, referenced by an ordinary link.

**What the sibling buys that this does not:** a rendered `.svg` that GitHub draws
inline, so a design is visible in a pull request without Galley. That is a real
loss and the main reason to revisit.

**Why the document won anyway:** the server stores documents — Markdown with
frontmatter, an id, a history, comments, suggestions, an anchor tray, a CLI read
path. A second storage type would have had to earn all of that again, and the
difference a reader sees is nil: a design document is still a file on disk, still
has its own identity, is still citable from any number of prose documents, and
still keeps its own timeline. The inline-in-the-prose-document option was rejected
for the reasons the research gives and they were decisive: every canvas nudge
would land in the spec's diff and its timeline, and a design with no identity of
its own cannot be shared between two documents, which is most of what a design
reference is for.

**The path back** is short if the SVG matters: render the design headlessly, write
the sibling `.svg`, and change the link to an image-inside-a-link. The format does
not move.

---

## `w-` and `h-` accept raw pixels, and nothing else does

The design vocabulary is closed — there is no way to write a literal colour, a
literal spacing, a literal radius. `w-` and `h-` are the exception: `h-44` means
forty-four pixels.

The consistent alternative was to force sizes onto the spacing scale. It was
rejected because a control's height and an avatar's width are genuinely
*dimensions* rather than rhythm, and putting them on a 4px ladder produces `h-11`
meaning 44px by a coincidence no reader can see. The pressure this creates is
real and worth naming: it is the one place a model can write a number nobody
chose, and the first sign of trouble will be designs full of `h-37`. If that
happens, the fix is a closed size scale rather than reopening the argument.

---

## Images: bytes in the database, addressed by their hash

A pasted image has to live somewhere. Three forks were open, and the reasoning
for each is worth keeping because two of them keep looking attractive.

**A data URI in the Markdown.** Zero infrastructure, and the document stays a
single self-contained file — which is genuinely tempting for a product whose
first claim is "the file is the payload". Rejected because the payload is read
by *agents*: a 400 KB screenshot becomes 540 KB of base64 in the middle of a
paragraph, and every model that reads the document pays for it, forever, on
every read. It also makes a one-word edit to that paragraph a half-megabyte
diff.

**A sibling folder on disk.** What the research recommended, and what makes a
workspace copyable and committable with its images intact. Rejected *for now*
only because the server has no filesystem story at all — documents live in
SQLite — and adding one for images would mean two storage models, two backup
stories, and a way for an asset to outlive or predate the document that
references it. `galley pull` is the place this becomes worth revisiting: a
mirrored workspace whose images are `/v1/assets/…` URLs is not really mirrored.

**Bytes in the database, addressed by content hash.** What shipped, and `pull`
now writes them out to an `assets/` folder and rewrites the references, so a
mirrored workspace really is one — the sibling-folder option below turns out to
be reachable *from* this one rather than instead of it. A workspace
stays one file to back up, the same screenshot pasted into four documents is
stored once, and — the property that made the decision — the URL is a function
of the bytes, so a re-save of the paragraph produces *identical* Markdown and
the splice cache still hits. A random filename would have turned every save of
that paragraph into a fresh diff, which is the failure the entire splicing
engine exists to prevent.

**SVG is refused, and that is not caution.** It is the one image format that is
a document: it can carry script, and serving one from the app's own origin
would hand any uploader a same-origin execution surface. "It is only an image"
is false for exactly one format, and this is it. The cost is real — an exported
diagram is often an SVG — and the answer is that diagrams are a fence, not an
upload.

**Base64 over JSON rather than multipart.** A third more bytes on the wire, for
one transport that the app, the CLI and every test already speak. Revisit if
uploads ever become large enough for the overhead to be the constraint, which
at a 4 MB cap they are not.
