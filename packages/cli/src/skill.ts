/**
 * The first-party Galley skill.
 *
 * `idea.md`: "Skills carry the etiquette that the CLI can't enforce. The CLI
 * gives an agent *capability*; a Galley skill gives it *behavior* — the
 * citation convention, the comment budget, suggestion-before-write, how to
 * scope a rewrite so block identity survives."
 *
 * Shipped as a string rather than a file in the package so that `galley skill`
 * works from a single-file bundle, with no data-file resolution to get wrong.
 */
export const SKILL_MARKDOWN = `---
name: galley
description: Read, cite, annotate and propose edits to Galley documents. Use whenever a task involves a spec, policy, runbook or prompt stored in Galley — reading one for context, answering a question from one, or updating one after the code changed.
---

# Working with Galley documents

Galley is where this team's specs, policies and prompts live. A document is
Markdown; every block in it has an identity you can cite and attach work to.

## Reading

After \`galley pull\`, documents are ordinary \`.md\` files in the folder. **Read
them with your normal file tools.** There is nothing to learn.

Use the CLI for what a filesystem cannot express:

\`\`\`
galley read specs/checkout-v2            # exact bytes, on stdout
galley read specs/checkout-v2#a1b2c3     # one block
galley search "refund policy"            # matching blocks, as path#block refs
\`\`\`

\`galley read\` writes the document and nothing else, so it pipes:

\`\`\`
galley read specs/checkout-v2 | your-tool
\`\`\`

## Citing

When an answer rests on a document, cite the block it came from — \`path#block\`.
A reader can click it and land on the exact paragraph. An uncited claim about
what a spec says is a claim the reader has to go verify by hand, which is most
of the work you were supposed to save them.

Get a block's id from \`galley search\`, or from the \`<!-- ^id -->\` marker in the
file. Blocks without a marker have not been annotated yet; cite them as
\`path#@N\` where N is the block's position, or leave a comment first, which mints
a durable id.

## Commenting

\`\`\`
galley comment specs/checkout-v2#a1b2c3 "This contradicts §Validation/¶1." --run <run-id>
\`\`\`

**Budget: at most five comments per document per run, and fewer is better.**
This is enforced — the sixth is refused — but treat the limit as a ceiling
rather than a target. A document with nineteen comments on it is a document
nobody will read. If you have more than five things to say, say the three that
change what someone will do.

Comment when you have found a *contradiction, an ambiguity, or a fact that is
now wrong*. Do not comment to say a paragraph is fine.

## Proposing an edit

**Never write to a document directly.** Propose, and a human reviews it:

\`\`\`
galley suggest specs/checkout-v2#a1b2c3 --from ./new-paragraph.md --why "the implementation now requires currency"
\`\`\`

Scope every proposal to the blocks that actually change. This is not a style
preference — it is what carries block identity through your rewrite. A comment
thread anchored to a paragraph survives your edit if you replaced *that
paragraph*; it orphans if you replaced the document.

For a multi-block change, issue one scoped proposal per block. \`galley suggest\`
on a whole document derives scoped operations for you, and **refuses outright**
if what you supplied shares almost nothing with the current version — that is a
new document, not an edit, and a person needs to make that call.

Write a real \`--why\`. The reviewer is deciding whether to trust a change they
did not make; "updated the spec" tells them nothing.

## Diagrams

A diagram is an ordinary fenced code block with the info string \`mermaid\`. It
is the same bytes GitHub, GitLab and Obsidian already draw, so you write one by
writing a fence:

\`\`\`
\`\`\`mermaid
flowchart TD
  Start([Start]) --> Done([Done])
\`\`\`
\`\`\`

There is no diagram-specific command and no new op type. Editing a diagram is
editing the block that holds it.

## Designs

A design is its own document whose body is a single \`design\` fence. It has an
id, a history and comments like any other document, and a prose document points
at one with an ordinary link.

\`\`\`
galley design outline designs/checkout      # structure only -- read this first
galley design source  designs/checkout      # the markup
galley design lint    designs/checkout      # what is wrong, and the fix
galley design classes                       # the vocabulary itself
\`\`\`

Read the **outline** before the source. It is a fraction of the size and it is
usually enough to find the layer you want.

The format is a small tree of \`<box>\`, \`<text>\` and \`<image>\` inside a
\`<frame>\`, laid out by flexbox, styled only with class names from a **closed**
vocabulary. Two rules follow, and both matter more than they look:

- **Never invent a class.** There is no syntax for a literal colour or size --
  \`bg-[#2463eb]\` and \`bg-blue-500\` are both errors. Run
  \`galley design classes\` and use what is there. Colours are named by role
  (\`bg-surface\`, \`text-fg-muted\`, \`bg-accent\`), never by hue.
- **Never reach for a coordinate.** There is no way to position a layer
  absolutely. Say what the arrangement *is* -- \`flex-col gap-4\` -- and let the
  browser do the arithmetic. You cannot measure rendered text and neither can the
  format, which is why this works.

Run \`galley design lint\` before you propose a design. It exits non-zero on an
error and its messages carry the fix.

### Components

A design says a thing once and uses it many times:

\`\`\`
<design name="Kit">
  <define name="Button">
    <box class="flex items-center justify-center h-40 px-4 bg-accent rounded-md hover:bg-accent-hover">
      <text name="slot:label" class="text-body text-on-accent">Button</text>
    </box>
  </define>
  <frame name="Screen" width="390" class="flex flex-col gap-3 p-6 bg-canvas">
    <use component="Button" label="Pay $42.00" />
    <use class="grow" component="Button" label="Cancel" />
  </frame>
</design>
\`\`\`

- A \`<define>\` goes at the top and is **drawn nowhere**. It holds exactly one
  layer; two roots is two components.
- A layer named \`slot:something\` is what a \`<use>\` can override, by writing
  \`something="..."\` on it. Only text varies — a component whose every property
  can be overridden is a shape with extra steps.
- A \`<use>\` carries its own \`class\`, because where a thing sits is not part of
  what it is. Those classes win over the definition's.
- Change the definition to change every use. Change a slot to change one.

### States

Four prefixes describe what a thing looks like when you touch it:
\`hover:\`, \`press:\`, \`focus:\`, \`disabled:\`. They take the same class names
everything else does — \`hover:bg-accent-hover\`, \`focus:border\`. There are no
others; anything past these four is behaviour, and behaviour belongs in code.

### Changing one

Do not rewrite the fence. Send **ops** -- the same eight operations the canvas
itself produces when someone drags a box with a mouse:

\`\`\`
galley design apply designs/checkout --ops changes.json --dry-run   # try it
galley design apply designs/checkout --ops changes.json             # propose it
\`\`\`

\`\`\`json
[
  { "intent": "make the primary action read as primary",
    "op": { "op": "set-classes", "id": "l_0_3",
            "classes": ["flex", "items-center", "justify-center", "h-48", "bg-accent", "rounded-md"] } },
  { "intent": "say what it does", "op": { "op": "set-text", "id": "l_0_3_0", "content": "Pay $42.00" } }
]
\`\`\`

The ops are \`set-classes\`, \`set-text\`, \`set-name\`, \`set-image\`,
\`set-frame\`, \`set-slot\`, \`insert\`, \`delete\` and \`move\`. Ids come from
\`galley design outline\`. Every op takes an \`intent\`, and you should write
one: a reviewer reading eleven class changes cannot tell from the diff what you
were trying to do.

Three things will be refused, and the messages say which:

- **A malformed op.** Shape, types and ranges, before the document is even read.
- **A change that breaks something.** Not "the design has problems" -- the ones
  already there are not yours -- but a problem your change *introduced*, such as
  text that no longer contrasts with what it sits on.
- **A rewrite in batch form.** Restructuring most of a design is not an edit to
  it. Propose the pieces separately so each can be reviewed.

Start with \`--dry-run\`. It runs all three checks and prints the result without
writing anything.

## Checking your work

\`\`\`
galley status                 # what changed, what is stale, what is pending
galley suggestions specs/checkout-v2 --state pending
galley orphans specs/checkout-v2
\`\`\`

If \`galley status\` shows orphaned anchors after your work, you replaced blocks
you should have edited. Say so rather than leaving it for someone to find.

## What not to do

- Do not rewrite a document wholesale to "clean it up".
- Do not resolve someone else's comment thread.
- Do not accept a suggestion, including your own. Acceptance is a human act and
  the CLI will refuse it.
- Do not edit the \`<!-- ^id -->\` markers. They are block identity; changing one
  silently detaches every comment on that block.
- Do not add a \`galley:\` frontmatter key by hand. Document identity is minted
  once, and a duplicate makes two documents claim to be the same one.
- Do not invent a design class name. An unknown class is an error, not a
  fallback, and a design that does not lint is a design that will not draw.
- Do not hand-edit a design's \`id="l_..."\` attributes. They are layer identity,
  and a note on a layer finds it by id.
`;
