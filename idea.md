# A Document Is a Repository

**Product vision, v0.1**

---

## The one sentence

A Google Docs–grade writing surface where the file on disk is plain Markdown, every block is addressable, and humans and agents collaborate through the same presence, comment, and permission model.

---

## Part 1 — Pulling it apart

Five things in the original brain dump don't survive contact with each other. Naming them is what makes the rest cohere.

### 1. "Markdown for non-technical people" is a contradiction until you split format from interface

Non-technical people do not want Markdown. They want bold text. They will never type `**bold**`, they will not learn what a fenced code block is, and the moment they see `|---|---|` they close the tab.

The resolution is not to make Markdown friendlier. It's to **stop showing it to them.**

> Markdown is the storage format. It is not the interface.

The interface is WYSIWYG, always. Source view is a toggle for the people who want it, not a mode anyone is dropped into. This is the single most important decision in the product, and everything else follows from it. Get it wrong and you've built HackMD with a nicer logo.

### 2. "Docs are the same level as code" is a slogan until you say what it means operationally

It could mean four different things. Pick deliberately:

| Reading | What it implies | Keep? |
|---|---|---|
| Docs live in the repo | File-on-disk fidelity, folder awareness | **Yes** |
| Docs get reviewed like code | Threads, resolution state, approvals | **Yes** |
| Docs have history like code | Scrubbable timeline, restore, branch-ish | **Yes, as UX** |
| Docs are stored in git | Commits, diffs, merges, conflicts | **No** — you already cut this |

You cut git plumbing, which is correct. But you have to keep the *cultural* half — review, resolution, attribution, history — or the principle is empty. **Code-grade rigor, zero git surface area.**

### 3. The local↔cloud story has an undefined middle

"Open your local doc, turn on a session, it syncs live" is clear until you ask: three people are editing the cloud copy and someone runs `git pull` on the laptop and the file changes underneath. Now what?

The clean answer, and it needs to be stated as law:

> **During a session, the CRDT is the source of truth. The local file is a continuously-written projection of it.**

A filesystem watcher treats external edits to the file as *inbound operations*, not as a competing version. They get diffed against the projection and applied as ops with an attribution of `local filesystem`. There is no merge dialog, ever. If the laptop goes offline, the session continues in the cloud and the file reconciles on reconnect — same path, no special case.

This is one rule, applied everywhere. Products in this space die from having three rules.

### 4. "Agent-native comments" is under-specified

"An agent can post a comment" is table stakes and worth nothing. The real idea underneath is stronger:

> A comment is a **work item scoped to a span of text**, with state, an assignee, and an audit trail.

That means an agent mentioned in a thread receives the anchored content, not the whole doc. It knows exactly which paragraph it's been asked to fix. It replies in-thread, its edit is attributed, and resolving the thread is a reviewable act. You have quietly invented an issue tracker that lives inside prose — which is exactly what "docs are the same level as code" should feel like.

### 5. The design canvas and the vision agent are a second product

Your instinct to split the canvas is right, and the same logic retires the OpenCV/Playwright thread for now. Both are about *seeing rendered output*, both have their own data model, and neither is load-bearing for "non-technical people collaborate on docs."

Cut them from v1. Keep one hook: a **generic embed primitive**, so a canvas — or anything else — can be dropped in later without a format change.

---

## Part 2 — Putting it back together

### Three pillars

**I. Markdown is the format, not the interface.**
WYSIWYG by default. The file on disk is clean, portable CommonMark that opens correctly in any other editor. Never a lock-in format.

**II. Everything is addressable.**
Every block has a stable identity. This is what makes comments, agent tasks, cross-doc references, and history actually work — and it's the one real gap in Markdown.

**III. Humans and agents share one model.**
An agent is a cursor, an author, a commenter, and a permission subject. Not a chat sidebar bolted onto the side.

---

### The sync engine

```
   local file  ←──────  projection writer
   (clean .md)  ──────→  fs watcher ──┐
                                      ↓
                              ┌───────────────┐
   browser session  ←────────→│  CRDT (doc)   │
   agent session    ←────────→│  authoritative │
   mobile           ←────────→└───────────────┘
                                      ↓
                              sidecar store
                    (comments, block map, history, presence)
```

Two modes, one engine:

- **Cloud-native** — no local file. The doc lives in the CRDT store. Export on demand.
- **Local session** — you point the app at a file on disk. Session opens, file is ingested, CRDT becomes authoritative, projection writer keeps the file current in real time. Session closes, final flush, file is exactly what it should be.

Same code path. The local file is just an optional peer with an unusual transport.

**Build on an existing CRDT.** Yjs or Loro. Writing your own is a two-year detour that adds nothing a customer can see.

---

### Where Markdown actually breaks, and the minimal fix

The temptation is to invent a rich format. Resist it — that's how you get a walled garden and lose "opens anywhere," which is half your value.

The discipline: **every extension degrades gracefully to valid CommonMark.**

| Gap | Why it matters here | Fix |
|---|---|---|
| **No block identity** | Comments, agent tasks, references, and history all need a stable anchor | Sidecar block map, materialized into the file only when a durable anchor exists |
| **Frontmatter is untyped** | Status/owner/reviewer are the doc's metadata layer | Schema'd frontmatter, rendered as UI chips, still valid YAML |
| **Tables are miserable** | Non-technical users live in tables | Edit as a grid; serialize to pipe tables; overflow to a fenced block when pipe tables can't express it |
| **No transclusion** | Docs-as-code means DRY docs | `![[doc#block]]`, degrades to a link |
| **No callouts** | Every doc tool has them; users expect them | Adopt the GitHub/Obsidian `> [!NOTE]` convention. Don't invent one. |
| **No rich embeds** | Canvas, dashboards, whatever comes later | Fenced block with a type; degrades to a visible link |

#### The block-identity decision, specifically

This is the one real format question, and it has a good answer.

- IDs live in the **sidecar**, keyed by content hash plus structural position.
- When the file is edited externally and blocks drift, re-anchor by fuzzy match. Prose doesn't move that fast; this works in practice.
- Only when a block acquires something durable — a comment thread, an agent task, an inbound reference — do you **materialize** the ID into the file as an HTML comment (`<!-- ^a1b2c3 -->`), invisible in every CommonMark renderer.

Result: a doc nobody has commented on is byte-for-byte clean Markdown. A doc under active review carries a small amount of invisible plumbing. The cost is paid only where the value is received.

---

### Comments, concretely

- Anchored to a block or a span within a block.
- Threaded, with open/resolved state and an assignee.
- **Email is full-duplex.** Notification out, reply-by-email lands in-thread. Proven mechanic, low risk, disproportionate retention value for non-technical collaborators who live in their inbox.
- `@agent` in a thread dispatches a scoped task. The agent receives the anchor plus surrounding context, not the whole doc.
- Agent edits land as **suggestions** by default, not direct writes. This is the trust primitive of the entire product. Ship it this way even though direct-write demos better.

---

### History without git

Users get: a scrubbable timeline, named checkpoints, per-block attribution ("who wrote this sentence, and when"), and restore.

Users never get: commits, branches, merges, conflicts, or the word "rebase."

The CRDT's operation log gives you all of the first list for free. Don't expose the second list to buy credibility with engineers — they're not the ones who need convincing.

---

## Part 3 — Scope

**v1 ships**
Real-time multiplayer editing · WYSIWYG-first with source toggle · clean Markdown on disk · local-session sync + cloud-native mode · anchored comment threads with state · email round-trip · agents as first-class participants with suggestion-mode edits · scrubbable history · typed frontmatter · grid table editor

**v2**
Transclusion · cross-doc references and backlinks · approval workflows · folder/workspace-level views · embed primitive opened up

**Separate product**
Design canvas · agent visual feedback on rendered output

**Cut**
Git plumbing · a new file extension · anything that makes the file unreadable in another editor

---

## Part 4 — The wedge

The positioning risk is real: "easy for non-technical people" and "code-grade collaboration" pull in opposite directions, and a product that chases both without a specific first user becomes Notion-but-worse.

The wedge that resolves it:

> **Non-engineers who need to work in engineering's docs.**

PMs, designers, technical writers, support leads. They are currently locked out of `/docs` because it lives in a repo, so they write the same content in Notion, and now there are two versions and one is wrong. They are the buyer's pain, they are non-technical by definition, and serving them *requires* both principles simultaneously. No other user segment forces you to build the right product.

Land there. Expand outward once the file-fidelity story is bulletproof.

---

## Part 5 — What will actually kill this

1. **Sync edge cases.** External file edits during a live session, offline reconnect, large-file ingest, a file that's a symlink, a file someone deletes mid-session. Budget more here than feels reasonable. This is where the product lives or dies.
2. **The WYSIWYG↔Markdown round-trip.** Every editor in this category has a bug where opening and saving a file silently reformats it. If a user's `git diff` shows noise they didn't create, you have lost the docs-as-code crowd permanently. Round-trip fidelity is a P0 test suite, not a polish item.
3. **Agent comment spam.** Give agents a budget and a scope. An agent that leaves nineteen comments makes the doc unusable.
4. **Positioning drift.** The moment you say "and also wikis, and also project management," you're competing with Notion on their turf. Stay narrow.

---

## Open questions

- Does the local session require a desktop app, or can File System Access API carry it in-browser? Desktop is better but it's a distribution cost.
- Where does the sidecar live for a local file — a dotfile beside it, or cloud-only? Dotfile means it survives sharing; cloud-only means the repo stays clean. This is a real fork.
- What's the permission model for an agent acting on behalf of an absent user?
- Does a doc have an owner, or does a workspace?

---

## Names

Not urgent, but you'll want to stop calling it "the markdown thing":

**Ply** · **Anvil** · **Margin** · **Recto** · **Sidecar**

`Margin` is the one I'd argue for — it's where comments live, it's a writing word, and it's not taken by a dev tool.