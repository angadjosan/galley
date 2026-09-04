/**
 * Claim under test: **a change arriving from another writer does not delete
 * what this session has typed and not yet sent.**
 *
 * `loadAll` refetches the whole document on every `changed` notification, and
 * the editor is re-seeded from what comes back. The guard that decided whether
 * to re-seed compared the live editor text against the fetched text — which
 * differ *precisely because* there is unsaved work, the one case the guard
 * existed to exclude. So a collaborator saving any block deleted every word
 * typed here since the last save, and set the badge to "Saved".
 *
 * The replacement rebases: the unsent edits are scoped block ops addressed by
 * id, so they replay onto the document that arrived. These tests cover the
 * composition that does it, which is pure.
 */
import { describe, expect, it } from 'vitest';
import { applyBlockOps, parseDocument } from '@galley/markdown';
import { diffToBlockOps } from '@galley/core/diff';

/** What `loadAll` does when the server moved and this session has unsent work. */
function rebase(base: string, local: string, incoming: string): string {
  return applyBlockOps(parseDocument(incoming), diffToBlockOps(base, local)).source;
}

const BASE = `# Checkout v2 <!-- ^h0 -->

The currency field is optional. <!-- ^p1 -->

Support may override this. <!-- ^p2 -->
`;

describe('rebasing unsent edits onto a collaborator change', () => {
  it('keeps both writers when they are in different blocks', () => {
    // This session, typing and not yet saved.
    const local = BASE.replace('The currency field is optional.', 'The currency field is required.');
    // Someone else, already landed on the server.
    const incoming = BASE.replace('Support may override this.', 'Support cannot override this.');

    const merged = rebase(BASE, local, incoming);

    expect(merged).toContain('The currency field is required.');
    expect(merged).toContain('Support cannot override this.');
  });

  it('is what the old re-seed threw away', () => {
    const local = BASE.replace('The currency field is optional.', 'The currency field is required.');
    const incoming = BASE.replace('Support may override this.', 'Support cannot override this.');

    // The previous behaviour: adopt the server's copy wholesale.
    expect(incoming).not.toContain('The currency field is required.');
    // The new one keeps it.
    expect(rebase(BASE, local, incoming)).toContain('The currency field is required.');
  });

  it('carries block identity through, so comments stay anchored', () => {
    const local = BASE.replace('The currency field is optional.', 'The currency field is required.');
    const incoming = BASE.replace('Support may override this.', 'Support cannot override this.');

    const merged = rebase(BASE, local, incoming);

    for (const marker of ['^h0', '^p1', '^p2']) expect(merged).toContain(marker);
  });

  it('keeps a collaborator insert and this session edit together', () => {
    const local = BASE.replace('The currency field is optional.', 'The currency field is required.');
    const incoming = `${BASE}\nA new closing paragraph. <!-- ^p3 -->\n`;

    const merged = rebase(BASE, local, incoming);

    expect(merged).toContain('The currency field is required.');
    expect(merged).toContain('A new closing paragraph.');
  });

  it('produces nothing to replay when this session has no unsent work', () => {
    expect(diffToBlockOps(BASE, BASE)).toHaveLength(0);
  });
});
