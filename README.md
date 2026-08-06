# Galley

A Google Docs–grade writing surface for people who don't write Markdown, where
the artifact it produces is clean, block-addressable Markdown that agents can
read, cite, and edit.

> **A document has two audiences. Write for the human, store for the machine.**

`idea.md` is the design doc and the source of truth for *why*. `decisions.md`
records what is true about this codebase and why you should not "fix" it.
`tradeoffs.md` records the forks not taken.

---

## Run it

```bash
npm install
npm run dev:api          # seeded API on :8787, prints a token
npm run dev:web          # editor on :5173
```

Open the URL the API prints. It carries a token; the app moves it out of the
address bar on first load.

```bash
npm test                 # unit and integration — 571 tests, ~13s
npm run test:stress      # concurrency, saturation, chaos, latency
npm run test:e2e         # both walkthroughs, headless, real browser
npm run typecheck
```

---

## The CLI

The agent-facing surface is a binary, not a server — the one integration point
every harness already has.

```bash
galley auth login --server http://localhost:8787 --token glly_…
galley pull ./docs                     # mirror a workspace to disk
galley read specs/checkout-v2          # clean Markdown on stdout
galley read specs/checkout-v2#a1b2c3   # one block
galley search "refund policy"          # matching blocks, as path#block refs
galley comment <ref> "…"               # anchored comment
galley suggest <ref> --from patch.md   # propose an edit, as block-scoped ops
galley design outline <ref>            # a design's structure, without its styling
galley design lint <ref>               # what is wrong with a design, and the fix
galley design classes                  # the design vocabulary, served by the tool
galley push                            # local edits back, as suggestions
galley status                          # what changed, what is stale, what is pending
galley skill                           # write the first-party agent skill
```

After `pull`, the documents are just files in a folder — every coding agent
already knows how to read files. The commands exist for what a filesystem
cannot express: addressing a block, searching semantically, posting a comment,
proposing an edit.

`galley read` writes the document's bytes and nothing else, so it composes:

```bash
galley read specs/checkout-v2 | claude -p "implement this"
```

---

## Layout

```
packages/
  concurrency/   locks, channels, sequencing, watermarks — the only place
                 synchronization is implemented
  design/        the design format: a closed utility vocabulary over a flexbox
                 tree, its strict parser, its serializer and its linter
  markdown/      the splicing round-trip engine: parse with source ranges,
                 edit by splicing, never re-serialize
  anchor/        block identity, fingerprints, fuzzy re-anchoring
  core/          CRDT document (Loro), sidecar, the per-document actor
  server/        SQLite storage, auth, HTTP API, WebSocket sync hub
  client/        one typed client, shared by the CLI and the app
  cli/           the galley binary and the first-party skill
apps/
  web/           ProseMirror WYSIWYG, the menu bar and toolbar, the diagram
                 renderer, the design canvas, comment and review rails
corpus/          Markdown the round-trip engine must not disturb
tests/
  stress/        concurrency, saturation, chaos, latency
  e2e/           the two walkthroughs, through a real browser
```

---

## What carries the product

**A surface nobody has to be taught.** An always-visible toolbar and a menu bar
that enumerates everything the app can do, over a real 816px page. This reverses
an earlier design built on a `/` menu and a selection bubble; `decisions.md` D38
records why the earlier reasoning was persuasive and wrong. Hidden controls are
efficient for someone who already knows the tool and a wall for everyone else,
and this product is explicitly for everyone else. Font, size, colour and
alignment are deliberately absent — Markdown cannot express them, so the button
would either lie or destroy the setting on the next save.

**Pictures that are still text.** A diagram is a ```mermaid fence — the same
bytes GitHub already draws — shown in the editor as a picture with an Edit
affordance and never as a fence. A design is its own document holding a small
flexbox tree styled from a closed vocabulary, so a model can write one, a GUI
edit changes one line, and nothing in the pipeline ever has to measure text.

**Round-trip fidelity.** A document is never serialized from its AST. It is
parsed into a block model that keeps every byte offset, and edits are *spliced*
into the original text — so editing one paragraph produces a one-paragraph diff.
The gate is byte equality across a corpus that includes this repo's own design
docs, asserted two ways: parse-and-re-emit, and the stronger form where every
block is replaced with its own source.

**Block identity.** Comments, citations, agent scoping, attribution and
staleness are six features that are secretly one feature, and the one gap in
Markdown. An id materializes into the file only when a block acquires something
durable, as an invisible trailing comment. Edits made through Galley carry
identity by construction; edits arriving through the filesystem are re-anchored
by content and context, and **anything ambiguous orphans rather than guessing**.
The CI gate: ≥95% survival across realistic agent rewrites, zero silent
misattachments. Measured: 98.2% over 13,786 anchors, zero.

**Suggestion-by-default.** An agent proposes; a human accepts. Enforced rather
than encouraged: the actor refuses acceptance by any agent principal, `stale` is
terminal for acceptance, and whole-document replacement is refused at three
independent layers because each is reachable without the others.

**Defined behaviour under concurrency.** Every mutation of a document is
serialized and ticketed, so "which came first" is always answerable — the
property attribution, staleness and the session boundary all depend on. A
whole-file replacement is not an edit but a new version, and the response is a
seal-and-drain session boundary rather than a merge dialog.

---

## What the tests are for

The suites are organised by the claim they defend, not by the module they
touch. Each file opens with the claims it tests and what it deliberately leaves
to a sibling.

| Suite | Defends |
|---|---|
| `packages/markdown` | byte stability; a corpus edit changes only what you typed |
| `packages/design` | a design round-trips byte-exactly; an edited layer changes one line; an unknown construct is reported, never dropped |
| `packages/anchor` | the ≥95% / zero-misattachment gate |
| `packages/concurrency` | fairness, cancellation safety, fault vs. close |
| `packages/core` | ordering, session boundaries, suggestion states |
| `packages/server` | permissions, durability, slow-client policy |
| `tests/stress` | nothing lost, nothing half-applied, nothing deadlocked — checked *during* the storm, not after |
| `tests/e2e` | the two walkthroughs, including a comment surviving an agent's rewrite |

Randomised tests are seeded and print their seed in the failure message. Latency
is measured and printed; only shape is asserted, because absolute milliseconds
are a property of the machine and a suite that goes red on a busy runner is a
suite everyone learns to ignore.
