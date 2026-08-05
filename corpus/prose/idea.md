# Galley

**Design doc, v0.3**

A galley proof is the draft you circulate before publication — the version that exists to be marked up. That's the product.

---

## The one sentence

A Google Docs–grade writing surface for people who don't write Markdown, where the artifact it produces is clean, block-addressable Markdown that agents can read, cite, and edit.

---

## The thesis

Every document written today has a second audience nobody designed for: a model.

Specs get pasted into coding agents. Policies get scraped into retrieval pipelines. Runbooks get handed to an assistant that's supposed to follow them. The doc is no longer a thing a person reads once — it's **context**, consumed repeatedly by machines, and every tool people currently write in is hostile to that.

Notion exports mangled Markdown and hides the good stuff behind an API you have to crawl. Google Docs is a rendering format pretending to be a storage format. Confluence is a database with a WYSIWYG on top. In all three, getting a document *out* in a form a model can use is a lossy export job, and there is no way for a model to point back at the paragraph it used.

The people writing these documents are not engineers. They are PMs, designers, support leads, ops, founders, technical writers, marketers. They will never type `**bold**` and they should never have to.

> **A document has two audiences. Write for the human, store for the machine.**

That's the product. Not "Markdown for normies." Not "docs in git." A writing surface where the thing that comes out the other end is already the thing your agents need.

---

## Why anyone uses this

Concretely, in order of how often it will be the reason:

1. **What you paste into an agent is correct.** No export step, no mangled tables, no lost structure. The doc *is* the context.
2. **Agents can cite you back.** An answer says "per §Refunds/¶3" and that resolves to a real block you can click. Retrieval stops being a black box.
3. **An agent can propose an edit and you can review it like a person's edit.** Not a chat window that regenerates your document — a suggestion on a paragraph, with a diff, that you accept or reject.
4. **Stale docs get caught.** A doc that feeds agents is worse than useless when it's wrong — it launders bad information into confident answers. Blocks know when they were last touched and by whom, and what's reading them.
5. **It opens anywhere, forever.** The file is CommonMark. No proprietary format, no export hostage situation.

Note what's *not* on that list: real-time multiplayer. It's table stakes, it has to work, and it is not why anyone switches.

---

## Two walkthroughs

The architecture below only makes sense against these. If a decision doesn't serve one of them, it's out of scope.

### A. Human writes, agent consumes

Priya is a PM. She writes a spec in Galley — bold text, headings, a table of API fields, a callout for the open question. She never sees a `#` or a `|`.

She finishes and hands it to a coding agent. Not by copy-paste — she says "implement the spec at `specs/checkout-v2`," and the agent runs `galley read specs/checkout-v2`. It gets Markdown on stdout: the same bytes that are on disk, no conversion, the table as a table, the callout as a callout, and a stable ID on every block.

The agent implements it, and comes back with: "§API Fields/¶2 says `currency` is optional but §Validation/¶1 requires it. Which?" That's a comment thread anchored to both blocks. Priya answers in the thread, in prose, in her inbox.

### B. Agent writes, human reviews

The same spec, three weeks later. The implementation drifted. A coding agent that touched the code notices the doc no longer matches and proposes an edit: two paragraphs rewritten, one table row changed.

It lands as a **suggestion** — highlighted, attributed, diffable, scoped to exactly those blocks. Priya accepts one, rejects one, edits the third herself. The comment thread she had on one of those paragraphs is still attached afterward, because the paragraph kept its identity through the rewrite.

Everything hard in this document is downstream of that last sentence.

---

## Principles

**I. Markdown is the format, not the interface.**
WYSIWYG always. Source view is a toggle for people who want it, never a mode anyone is dropped into. Get this wrong and you've built HackMD with a nicer logo.

**II. Every block has a stable identity.**
This is the technical thesis. Block identity is what makes comments, agent scoping, citation, transclusion, attribution, and staleness all work — six features that are secretly one feature. It's also the one real gap in Markdown.

**III. Humans and agents share one model.**
An agent is a cursor, an author, a commenter, and a permission subject — not a chat sidebar bolted onto the side. The reason this matters isn't philosophical: it's **scoping**. An agent mentioned in a thread gets one anchored paragraph and its surroundings, not 40kb of document. Precision in, precision out.

**IV. Every extension degrades to valid CommonMark.**
The temptation is to invent a richer format. Resist it — that's how you get a walled garden and lose "opens anywhere," which is half the value.

---

## What agents actually need, and what to build for it

Being "agent-native" is four concrete capabilities, not a vibe:

| Capability | What to build |
|---|---|
| **Read** a doc as clean Markdown, no export step | The file on disk *is* the payload. Same bytes. |
| **Address** a specific block, stably, across edits | Block IDs, durable through rewrites (see below) |
| **Cite** back in a way a human can verify | `doc#block` resolves to a scroll-and-highlight in the app |
| **Propose** an edit that a human reviews | Suggestions as first-class objects, not direct writes |

### The interface is a CLI, plus skills

Not a server. Agents already have a shell — that's the one capability every harness has in common, and it's the only integration surface that costs nothing to adopt.

```
galley pull ./docs                     # mirror a workspace to disk
galley read specs/checkout-v2          # clean Markdown on stdout
galley read specs/checkout-v2#a1b2c3   # one block
galley search "refund policy"          # matching blocks, as doc#block refs
galley comment <ref> "..."             # anchored comment
galley suggest <ref> --from patch.md   # propose an edit (block-scoped ops)
galley status                          # what changed, what's stale, what's pending
```

Two things follow from this that a server surface doesn't give you:

**`galley pull` means the best agent interface is no interface.** Mirror the workspace and the docs are just files in a folder. Every coding agent already knows how to read files — no tool definition, no connector, no protocol. The CLI is for the operations a filesystem can't express: addressing a block, searching semantically, posting a comment, proposing an edit.

**Stdout composes.** `galley read spec | claude -p "implement this"` is a real workflow. So is a CI job that runs `galley status --stale` and fails when a doc that feeds production agents has drifted from the code. Long-lived connections can't do that; a binary can.

**Skills carry the etiquette that the CLI can't enforce.** The CLI gives an agent *capability*; a Galley skill gives it *behavior* — the citation convention, the comment budget, suggestion-before-write, how to scope a rewrite so block identity survives. Skills are files, so they version with the workspace and travel to whatever harness the user runs. Ship a first-party one, let teams fork it.

**Permissions.** `galley auth login` issues a scoped token to an *(agent, human sponsor)* pair — the agent is its own principal, never an impersonation of the sponsor, and its grants are always a subset of theirs. An agent's permissions are otherwise the same object as a human's: read `/policies`, suggest on `/specs`, write nowhere is a normal thing to express. Every command is auditable and replayable, which a persistent session is not.

The honest cost: a CLI can't push. An agent can't be *notified* that someone replied to its comment — it has to be run again and poll `galley status`. For the workflows above that's fine, and if a subscription surface is ever needed it can wrap the same commands.

---

## Architecture

### The sync engine

```
   local file  ←──────  projection writer (splicing)
   (clean .md)  ──────→  fs watcher ──┐
                                      ↓
                              ┌────────────────┐
   browser session  ←────────→│  CRDT (doc)    │
   agent via CLI    ←────────→│  authoritative │
   mobile           ←────────→└────────────────┘
                                      ↓
                              sidecar store
                (block map, comments, suggestions, history, presence)
```

Two modes, one code path:

- **Cloud-native** — no local file. The doc lives in the CRDT store. This is the default and it's where most users live.
- **Local mirror** — you point Galley at a file or folder on disk, typically because that's where your coding agents read from. Session opens, file is ingested, CRDT becomes authoritative, the projection writer keeps the file current in real time.

> **Law: during a session, the CRDT is the source of truth. The local file is a continuously-written projection of it.**

External edits to the file are *inbound operations*, not a competing version — diffed against the projection and applied as ops attributed to `local filesystem`. No merge dialog, ever.

Build on **Loro** rather than Yjs. This isn't a coin flip: two v1 requirements decide it. History-as-UX needs cheap version checkout, and suggestion review benefits from real branching. Yjs makes both into custom work. (Writing your own CRDT is a two-year detour that adds nothing a user can see.)

### The projection writer: splice, don't re-serialize

The failure mode that kills editors in this category: you open a file, save it, and it silently reformats. Markdown is not a canonical serialization — `*` vs `-` bullets, `_em_` vs `*em*`, ATX vs setext headings, nested-list indent width, two-space hard breaks, table pipe padding, escaping rules. Many ASTs produce the same text; many texts produce the same AST. Any AST→text serializer will reformat every file that wasn't already in its canonical style.

So don't serialize the document. **Keep source ranges per node, re-emit only the nodes that changed, and leave every untouched byte literally untouched.**

And say the honest part out loud rather than letting users find it in a diff:

> **First ingest normalizes, once, as a visible and explicit act. Every save after that is byte-stable.**

Normalization is a thing the user agrees to when they connect a file, not a bug they discover later. After it, editing one paragraph produces a one-paragraph diff. This is a P0 architectural commitment with a P0 test suite behind it — round-trip a large corpus of real-world Markdown, assert byte equality on no-op open/save.

### Block identity

The mechanism, in priority order — the ordering is the whole point:

1. **IDs are authoritative in the CRDT.** Any edit made through Galley — by a human, or by an agent through the CLI — carries block identity through the edit, because the editor knows which paragraph it is *while* it rewrites it. This is the path that must survive Walkthrough B.
2. **Fuzzy re-anchoring is the fallback**, used only for edits that arrive through the filesystem, where identity was never in the payload. Content-similarity plus structural position, with an explicit confidence threshold.
3. **Below threshold, the anchor is orphaned, not guessed.** Orphaned comments surface in a per-doc tray with their last-known text, reattachable in one click. Silently reattaching a comment to the wrong paragraph is worse than losing it.

Content hashing alone is not sufficient and shouldn't be the primary key — two identical `## Setup` headings or two short identical paragraphs collide by construction.

**Materialization.** IDs live in the sidecar. Only when a block acquires something durable — a comment thread, an inbound citation, an agent task — is the ID written into the file as an HTML comment (`<!-- ^a1b2c3 -->`), invisible in every CommonMark renderer.

A doc nobody has annotated is byte-for-byte clean Markdown. A doc under active review carries a little invisible plumbing. The cost is paid only where the value is received. Note the tradeoff honestly: **commenting on a doc modifies the file.** For repo-backed docs that means a diff caused by a social act. Accept it, and make sure the sidecar degrades gracefully when the marker isn't there — fall back to rule 2.

### The sidecar, and what it's keyed to

The interesting question isn't *where the sidecar lives* — it's cloud, with an optional exportable form for teams who want annotations to travel. The interesting question is **what it points at**, and that has a forced answer.

Keyed to a file path, renaming or moving a doc orphans every comment on it. Surviving renames requires a document identity that isn't its location. Typed frontmatter already exists in v1, so:

```yaml
---
galley: 01J8XK2M          # doc identity, survives rename and move
status: draft
owner: priya
---
```

One line, valid YAML, invisible in any renderer that shows frontmatter as metadata. It buys identity across renames, moves, and copies, and it's what a `doc#block` reference resolves against.

### Filesystem events: magnitude changes the semantic

"No merge dialog, ever" is the right law, and it breaks on one case. A `git checkout` replaces the entire file. Diffed against the projection, that's a huge inbound op set attributed to `local filesystem`, silently rewriting the document under everyone editing it, mid-sentence.

The refinement preserves the law rather than excepting it: a whole-file replacement isn't an edit, it's **a new document version**, and the response is a session boundary — not a dialog asking anyone to merge anything.

| Event | Defined behavior |
|---|---|
| Small external diff (below threshold) | Inbound ops, attributed to `local filesystem` |
| Whole-file replacement (branch switch, revert) | End session. Standalone doc: re-ingest as a new version, offer restore from history. Repo-mapped doc: mark **diverged**, don't promote — local edits become suggestions against canonical |
| Atomic save (write temp + rename) | Treat delete+create on the watched path as modify — this is what most editors actually do |
| Partial / in-progress write | Debounce, validate parse, never apply a half-file |
| File deleted mid-session | Session continues in cloud, file marked detached, one-click rewrite to disk |
| File is a symlink | Follow, watch the target, write through |
| Offline | Session continues in cloud, file reconciles on reconnect — same path, no special case |

This table is the section most likely to be under-budgeted and most likely to kill the product. It is not a polish item.

### Suggestions

A CRDT's premise is that everything merges. A suggestion is precisely an edit that must *not* merge until a human approves it. So a suggestion is **not** an op on the main document — it's a proposal object in the sidecar: anchor, replacement content, author, rationale, state.

```
pending → accepted (becomes ops, attributed to the proposer)
        → rejected (retained for audit)
        → stale     (underlying block changed since proposal)
```

`stale` is the state everyone forgets and it's the one that matters. If the paragraph moved out from under a proposal, show the proposal, mark it stale, never auto-apply it.

A suggestion is a set of **block-scoped ops** — replace, insert, delete, move — not a replacement blob. That's what carries identity through an agent rewrite (see the hard questions, #3), and the CLI rejects whole-document replacement on any doc that has durable anchors.

**Agent edits are suggestions by default.** This is the trust primitive of the entire product, and it should ship this way even though direct-write demos better. Direct-write is a per-doc, per-agent permission a human grants deliberately. An agent-authored suggestion is never auto-accepted, including by a rule its sponsor wrote.

### Comments

- Anchored to a block or a span within a block.
- Threaded, with open/resolved state and an assignee.
- **Email is full-duplex.** Notification out, reply-by-email lands in-thread. Disproportionate value for the non-technical collaborators who live in their inbox.
- `@agent` in a thread dispatches a scoped task — the anchor plus surrounding context, never the whole doc.
- Agents get a **comment budget per doc per run.** An agent that leaves nineteen comments makes the document unusable. This is a hard limit, not a guideline.

A comment is really a **work item scoped to a span of text**, with state, an assignee, and an audit trail. That's an issue tracker living inside prose, which is the correct shape for this.

### History

Users get: a scrubbable timeline, named checkpoints, per-block attribution ("who wrote this sentence, when, and was it a person"), and restore.

Users never get: commits, branches, merges, conflicts, or the word "rebase."

The operation log gives you all of the first list. Don't expose the second list to buy credibility with engineers — they aren't the ones who need convincing, and they already have git.

---

## Where Markdown breaks, and the minimal fix

| Gap | Why it matters | Fix |
|---|---|---|
| **No block identity** | Comments, citations, agent scoping, history all need an anchor | Sidecar block map; materialized into the file only when durable |
| **Frontmatter is untyped** | It's the metadata layer agents filter and route on | Schema'd frontmatter, rendered as UI chips, still valid YAML |
| **Tables are miserable** | Non-technical users live in tables | Edit as a grid; serialize to pipe tables; overflow to a fenced block when pipe tables can't express it |
| **No transclusion** | DRY docs; one definition, many places | `![[doc#block]]`, degrades to a link |
| **No callouts** | Every doc tool has them; users expect them | Adopt the GitHub/Obsidian `> [!NOTE]` convention. Don't invent one. |
| **No rich embeds** | Whatever comes later needs a door | Fenced block with a type; degrades to a visible link |

---

## Build order

Ordered by **uncertainty, not dependency**. Build the thing that can kill you first, because it's cheap to learn and expensive to discover late.

**1. The splicing round-trip engine + WYSIWYG, single local file.**
No multiplayer, no comments, no agents, no email. Success condition: open a real folder of documents, edit for an hour, and `git diff` shows only what you typed. Weeks, not quarters. If this fails, nothing downstream matters.

**2. Block identity + the CLI read path.**
`galley pull`, `read`, `search`, and a first-party skill. Point a coding agent at it and run Walkthrough A end to end. This is the first moment the product is *for* something — and because the CLI is a binary over the same store the app uses, it costs days, not a quarter.

**3. Comments + suggestions + the review UI.**
Walkthrough B. Identity has to survive an agent rewriting a commented paragraph — that's the acceptance test, and it validates every decision in the block-identity section. Gate: the anchor benchmark in CI, ≥95% survival across a corpus of real agent rewrites, zero silent misattachments.

**4. Real-time multiplayer, presence, history UI.**
Most expensive item, least uncertain. Loro works. Doing this later costs less than doing it first, because by now you know what the document model actually is.

**5. The GitHub app, email round-trip, typed frontmatter UI, grid tables.**

The GitHub app is what makes a cloud-native doc reach a repo without anyone cloning it. It's a v1 commitment, but it's low-uncertainty plumbing over an already-settled model, so it sits here rather than earlier.

Email is explicitly a proven mechanic — which means it teaches you nothing and can wait.

**Cut for now:** design canvas · agent visual feedback on rendered output · any git plumbing · a new file extension · anything that makes the file unreadable in another editor.

Keep one hook: a **generic embed primitive**, so a canvas or anything else can be dropped in later without a format change.

---

## The hard questions, decided

These were open in v0.2. Each one now has an answer, with the residual risk stated rather than hidden.

### 1. Docs that exist on several git branches at once

**Decision: one canonical version per doc identity. Galley never holds two versions of the same doc, and a branch variant is not a fork — it's a divergence to be reviewed.**

The `galley:` frontmatter ULID is the identity, and it is deliberately *not* a git ref. Comments, citations, suggestions, and history attach to `doc-identity#block` and nothing else. When a mirrored file's content stops matching the canonical version — which is exactly what a branch switch looks like — the whole-file replacement rule from the filesystem table fires: the session ends, and the file is marked **diverged** rather than ingested. A diverged file is not silently promoted into the doc; editing it produces suggestions against canonical, reviewed like any other.

The consequence to accept: a block that exists only on a feature branch has no anchor, so a comment left on it orphans into the tray. That's correct behavior — a comment on a paragraph that doesn't exist in the canonical doc has nowhere honest to live.

Why this is right rather than merely simple: docs drift across branches far less than code does, and the alternative — per-branch doc variants — splits the comment ecosystem in two, which is the one thing that makes the annotation layer worthless. Galley stays free of git vocabulary because the divergence is expressed in Galley's own primitives.

*(This gets easier still if the checkout model in `tradeoffs.md` is taken: a branch becomes a checkout that hasn't been pushed, and the same suggestion path covers it.)*

### 2. How a cloud-native doc reaches a repo

**Decision: server-side. A Galley GitHub app writes to the repo on the workspace's behalf. The repo is a publishing target, not a peer of the CRDT.**

The workspace declares a map — doc path in Galley → path in the repo → branch — and Galley commits accepted changes itself. The default is a single long-lived PR per doc, updated in place, so review lands in the reviewer's existing workflow; teams that don't want the ceremony can configure direct commits to a designated branch. The PM who wrote the doc never clones anything.

Inbound commits on a mapped path arrive as external edits attributed to `git`, through the same path as any other external edit. A teammate's local mirror is then just an ordinary checkout of that branch, and stops being load-bearing.

Residual risk: the app needs write scope on the repo, which is a real security conversation with any customer whose docs live next to their code. Read-only mode with export-a-patch is the fallback for teams that won't grant it.

### 3. Anchor loss under agent rewriting

**Decision: don't measure the risk, remove it. The CLI refuses whole-document replacement for any doc with durable anchors.**

`galley suggest` takes block-scoped operations — replace, insert, delete, move — each carrying identity. "Rewrite this whole section" is expressed as a sequence of those, not as a new blob of text, so identity flows through by construction rather than by fuzzy matching after the fact. Anchor loss becomes possible only where an agent explicitly deletes a block, which is semantically the right place to lose one. The skill teaches the etiquette; the CLI enforces the shape, because etiquette that isn't enforced is a suggestion to a model.

This still needs a number, so it becomes an acceptance gate rather than an unknown: a benchmark corpus of real agent rewrites over commented docs, run in CI, gating build step 3. **≥95% anchor survival, zero silent misattachments.** A misattachment is a bug of a different class than an orphan and is never traded off against the survival rate.

### 4. An agent acting for an absent human

**Decision: an agent is a first-class principal with its own identity. Never impersonation.**

`galley auth login` issues a token to an *(agent, sponsor)* pair. The agent's permissions are the intersection of the sponsor's grants and the token's declared scope — always a subset, never equal to the human's. The audit trail records both, and reads as `galley-bot/ci, sponsored by priya`. The agent is the actor; the sponsor is accountable for the grant.

What follows:

- Revoking a human's access revokes every token they sponsor. No orphaned 3am agents.
- Agents cannot sponsor agents. Delegation chains terminate at a person.
- A suggestion authored by an agent is never auto-accepted, including by rules the sponsor wrote. Suggestion-by-default is what makes an absent sponsor a non-problem: nothing lands while they're asleep.

### 5. Desktop app or File System Access API

**Decision: neither is the mechanism. The CLI is the local mirror.**

`galley pull` is already a binary that puts files on disk, and it's the surface agents use anyway — shipping a desktop app to do the same job buys no capability and costs a distribution channel, code-signing, and an update story. The File System Access API ships as a convenience for the browser-only user who wants a folder open, with its limits stated plainly: Chromium-only, per-session permission prompts, no background watching. If a user needs the mirror to be reliable, they install the CLI.

### 6. Does a doc have an owner, or does a workspace?

**Decision: both, doing different jobs — and only one of them is a permission.**

The **workspace** owns access: membership, permissions, billing. Permissions never come from a doc-level field, which is what keeps this out of per-doc ACL territory.

The **doc** has an `owner:` — an accountability field, a person, defaulting to the creator and freely reassignable. It routes the things that need a human: the staleness nudge ("this doc feeds three agents and hasn't been touched in 90 days"), suggestions nobody has reviewed, and orphaned anchors waiting in the tray. An unowned doc is a doc whose staleness is nobody's problem, which is how docs rot.

---

### Still genuinely unknown

Not open problems in the above sense — things that only measurement answers.

- Whether the ≥95% anchor-survival gate in #3 is achievable at the first attempt, or whether the block-op vocabulary needs a `move` semantic richer than the obvious one.
- Whether teams will grant repo write scope (#2) often enough that the server-side path is the main one, or whether read-only-plus-patch becomes the default in practice.

---

## What will actually kill this

1. **Round-trip fidelity.** Covered above. If someone's `git diff` shows noise they didn't create, the credibility is gone permanently and you don't get it back.
2. **Filesystem edge cases.** The table above, plus the ones not in it yet. Budget more than feels reasonable.
3. **Agent slop.** Nineteen comments, or a suggestion that rewrites a document into confident mush. Budgets, scoping, and suggestion-by-default are the defenses, and they have to be defaults rather than settings.
4. **Positioning drift.** The moment this says "and also wikis, and also project management," it's Notion-but-worse. The scope is: a writing surface whose output is machine-consumable. Stay there.
5. **Building an editor for three years before learning anything.** Which is what the build order above exists to prevent.
