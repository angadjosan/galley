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
`;
