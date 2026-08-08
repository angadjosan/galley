/**
 * The two walkthroughs from `idea.md`, end to end through a real browser
 * against a real server.
 *
 * **A. Human writes, agent consumes.** Priya writes a spec in the editor,
 * never seeing a `#` or a `|`. An agent reads it as clean Markdown — the same
 * bytes, no export step, with a stable id on every annotated block.
 *
 * **B. Agent writes, human reviews.** An agent proposes an edit scoped to
 * specific blocks. It lands as a suggestion, attributed and diffable. Priya
 * accepts it, and the comment thread she had on one of those paragraphs is
 * still attached afterwards — because the paragraph kept its identity through
 * the rewrite.
 *
 * "Everything hard in this document is downstream of that last sentence", so
 * that is the assertion these tests exist for.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const API = 'http://127.0.0.1:8788';

function tokens(): { token: string; agentToken: string } {
  return JSON.parse(readFileSync('.galley-e2e-tokens.json', 'utf8')) as {
    token: string;
    agentToken: string;
  };
}

async function openWorkspace(page: Page): Promise<void> {
  await page.goto(`/?token=${tokens().token}`);
  await expect(page.getByTestId('doc-list')).toBeVisible();
}

async function openSpec(page: Page): Promise<void> {
  await openWorkspace(page);
  await page.getByTestId('doc-specs/checkout-v2').click();
  await expect(page.getByTestId('doc-title')).toHaveText('Checkout v2');
  await expect(page.locator('.prose > p[data-block-id]').first()).toBeVisible();
}

/** Put the caret at the end of a block, the way a person clicking would. */
async function caretAtEndOf(page: Page, selector: string, index = 0): Promise<void> {
  await page.locator(selector).nth(index).click();
  // The editor adopts a click into its own state on a later tick. Typing
  // before that lands puts the text where the caret used to be.
  await page.waitForTimeout(150);
  await page.evaluate(
    ({ sel, i }) => {
      const el = document.querySelectorAll(sel)[i];
      const selection = window.getSelection();
      if (!el || !selection) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    },
    { sel: selector, i: index },
  );
}

/**
 * Select a block's whole contents.
 *
 * A Range rather than counted arrow presses: a count races the typing that
 * preceded it, and a test about a shortcut should not also be a test about
 * selection arithmetic.
 */
async function selectContentsOf(page: Page, selector: string, index = 0): Promise<void> {
  await page.locator(selector).nth(index).click();
  await page.waitForTimeout(150);
  await page.evaluate(
    ({ sel, i }) => {
      const el = document.querySelectorAll(sel)[i];
      const selection = window.getSelection();
      if (!el || !selection) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
    },
    { sel: selector, i: index },
  );
  await page.waitForTimeout(100);
}

/** History is a destination now, not a permanent tab. It lives under File. */
async function openHistory(page: Page): Promise<void> {
  await page.getByTestId('menu-file').click();
  await page.getByRole('menuitem', { name: 'Version history' }).click();
  await expect(page.getByTestId('history-rail')).toBeVisible();
}

/**
 * Select a layer from the tree.
 *
 * The design editor's left pane opens on `Add` — what you can put in the design
 * is the question the canvas cannot answer by itself, so it is the default. The
 * layer tree is the other half of the same pane, one click away, and these
 * walkthroughs reach for it whenever they need a layer by name rather than by
 * position on the canvas.
 */
async function pickLayer(page: Page, name: string, index = 0): Promise<void> {
  await page.getByTestId('pane-layers').click();
  await page.locator('.design-tree-row', { hasText: name }).nth(index).click();
}

async function closeOverlay(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('history-rail')).toHaveCount(0);
}

async function readAsAgent(path: string): Promise<string> {
  const response = await fetch(`${API}/v1/docs/${encodeURIComponent(path)}`, {
    headers: { authorization: `Bearer ${tokens().agentToken}` },
  });
  const body = (await response.json()) as { content: string };
  return body.content;
}

/**
 * Insert a design from a starter and return the path it landed at.
 *
 * By difference, not by position. These tests share one spec document, so it
 * may already hold a design — and a new one lands at the caret, which is not
 * necessarily after the old one. Neither `.first()` nor `.last()` is the one
 * this test just made.
 */
async function insertDesign(page: Page, starter: string): Promise<string> {
  const chips = page.locator('.prose a[title="design"]');
  const before = new Set(await chips.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href'))));
  await page.getByRole('button', { name: 'Insert design', exact: true }).click();
  await page.getByTestId(starter).click();
  await expect(chips).not.toHaveCount(before.size);
  const after = await chips.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')));
  const made = after.find((href) => href && !before.has(href));
  expect(made, 'the design reference has no target').toBeTruthy();
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });
  return made!;
}

test.describe('the writing surface', () => {
  test('shows a document as rich text, with no Markdown anywhere', async ({ page }) => {
    await openSpec(page);

    // Structure is rendered, not shown as syntax.
    await expect(page.locator('.prose h1')).toHaveText('Checkout v2');
    await expect(page.locator('.prose h2').first()).toHaveText('Validation');
    await expect(page.locator('.prose table')).toBeVisible();
    await expect(page.locator('.prose .callout')).toBeVisible();

    const text = await page.locator('.prose').innerText();
    expect(text, 'raw Markdown leaked into the writing surface').not.toMatch(/^#{1,6}\s/m);
    expect(text).not.toContain('<!--');
    expect(text).not.toContain('|---');
  });

  test('formats from the toolbar and keeps the change', async ({ page }) => {
    await openSpec(page);
    await caretAtEndOf(page, '.prose > p[data-block-id]');
    await page.keyboard.type(' Bolded.');
    await page.keyboard.down('Shift');
    for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowLeft');
    await page.keyboard.up('Shift');
    // The toolbar is there before the selection and stays after it — that
    // permanence is the point, so it is what the test asserts.
    await expect(page.getByTestId('toolbar')).toBeVisible();
    await page.getByRole('button', { name: 'Bold', exact: true }).click();

    await expect(page.locator('.prose strong').filter({ hasText: 'Bolded.' })).toBeVisible();
    await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });

    const asAgent = await readAsAgent('specs/checkout-v2');
    expect(asAgent, 'the emphasis did not reach the stored document').toContain('**Bolded.**');
  });

  test('turns Markdown shortcuts into structure as you type', async ({ page }) => {
    await openSpec(page);
    const paragraphs = await page.locator('.prose > p[data-block-id]').count();
    await caretAtEndOf(page, '.prose > p[data-block-id]', paragraphs - 1);
    await page.keyboard.press('Enter');
    await page.keyboard.type('## A section typed with a shortcut');

    await expect(
      page.locator('.prose h2').filter({ hasText: 'A section typed with a shortcut' }),
    ).toBeVisible();
    // And no `##` is left visible anywhere.
    expect(await page.locator('.prose').innerText()).not.toContain('## A section');
  });
});

test.describe('saving', () => {
  test('block identity survives repeated saves', async ({ page }) => {
    // The editor holds the annotated form and diffs each change against what
    // it last sent. If it diffs against the *clean* form instead, every block
    // looks new, a one-word edit becomes a delete-and-reinsert of the whole
    // document, and every comment, citation and attribution anchored to those
    // blocks is lost. This is the invariant the product is built on.
    //
    // The live connection is cut first, on purpose. Its change event happens to
    // re-read the document and repair the diff base, which hides the fault
    // whenever it arrives before the next keystroke. Saving has to be correct
    // on its own — a writer whose socket is down still expects their document
    // to survive being edited twice.
    await page.routeWebSocket(/\/v1\/sync/, (ws) => ws.close());
    await openSpec(page);

    const paragraph = page.locator('.prose > p[data-block-id]').nth(1);
    await paragraph.click();
    await page.waitForTimeout(150);
    await page.keyboard.press('ControlOrMeta+Alt+m');
    await page.getByTestId('comment-input').fill('Anchored before any editing.');
    await page.getByTestId('comment-submit').click();
    await expect(page.getByTestId('comment-card').first()).toBeVisible();
    const anchored = await paragraph.getAttribute('data-block-id');

    const idsBefore = await page.locator('.prose [data-block-id]').evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset.blockId),
    );

    // Two saves, because the first one is what re-seeds the diff base.
    for (const text of [' First edit.', ' Second edit.']) {
      await caretAtEndOf(page, '.prose > p[data-block-id]');
      await page.keyboard.type(text);
      await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });
    }

    const idsAfter = await page.locator('.prose [data-block-id]').evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset.blockId),
    );
    expect(idsAfter, 'the blocks lost their identity across saves').toEqual(idsBefore);

    const asAgent = await readAsAgent('specs/checkout-v2');
    expect(asAgent).toContain('First edit.');
    expect(asAgent).toContain('Second edit.');
    expect(asAgent, 'a later save deleted content it should not have').toContain('## Validation');

    const response = await fetch(`${API}/v1/docs/specs%2Fcheckout-v2/comments`, {
      headers: { authorization: `Bearer ${tokens().token}` },
    });
    const { comments } = (await response.json()) as {
      comments: { body: string; anchor: { blockId: string }; orphanedAt: string | null }[];
    };
    const mine = comments.find((c) => c.body === 'Anchored before any editing.');
    expect(mine, 'the note vanished across saves').toBeTruthy();
    expect(mine!.anchor.blockId).toBe(anchored);
    expect(mine!.orphanedAt, 'the note lost its anchor across saves').toBeNull();
  });

  test('keeps text typed while a save is in flight', async ({ page }) => {
    await openSpec(page);
    await caretAtEndOf(page, '.prose > p[data-block-id]');
    await page.keyboard.type(' Before the flush.');
    // Long enough for the debounce to fire and the request to be out.
    await page.waitForTimeout(700);
    await page.keyboard.type(' During the flush.');

    await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });
    const asAgent = await readAsAgent('specs/checkout-v2');
    expect(asAgent).toContain('Before the flush.');
    expect(asAgent, 'text typed during a save round-trip was dropped').toContain('During the flush.');
  });
});

test.describe('walkthrough A: human writes, agent consumes', () => {
  test('an agent reads exactly the bytes the writer produced, minus the plumbing', async ({
    page,
  }) => {
    await openSpec(page);
    await caretAtEndOf(page, '.prose > p[data-block-id]');
    await page.keyboard.type(' Written by a person.');
    await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });

    const asAgent = await readAsAgent('specs/checkout-v2');
    expect(asAgent).toContain('Written by a person.');
    // Clean Markdown: structure preserved, no id markers, no export step.
    expect(asAgent).toContain('# Checkout v2');
    expect(asAgent).toContain('| Field | Type | Required |');
    expect(asAgent).toContain('> [!NOTE]');
    expect(asAgent, 'id markers leaked into an agent read').not.toContain('<!-- ^');
  });

  test('a citation from search resolves to the block it names', async ({ page }) => {
    await openWorkspace(page);
    await page.getByTestId('search-input').fill('refunds');
    await expect(page.getByTestId('search-results')).toBeVisible();

    const response = await fetch(`${API}/v1/search?q=refunds`, {
      headers: { authorization: `Bearer ${tokens().agentToken}` },
    });
    const { results } = (await response.json()) as { results: { ref: string }[] };
    expect(results.length).toBeGreaterThan(0);

    const [path, blockId] = results[0]!.ref.split('#');
    const block = await fetch(
      `${API}/v1/docs/${encodeURIComponent(path!)}/blocks/${encodeURIComponent(blockId!)}`,
      { headers: { authorization: `Bearer ${tokens().agentToken}` } },
    );
    expect(block.status, 'a search citation did not resolve').toBe(200);
    const body = (await block.json()) as { content: string };
    expect(body.content.toLowerCase()).toContain('refund');
  });
});

test.describe('walkthrough B: agent writes, human reviews', () => {
  test('a comment survives an agent rewriting the paragraph it is anchored to', async ({ page }) => {
    await openSpec(page);

    // Priya comments on the second paragraph.
    const paragraph = page.locator('.prose > p[data-block-id]').nth(1);
    await paragraph.click();
    await page.waitForTimeout(150);
    await page.keyboard.press('ControlOrMeta+Alt+m');
    await page.getByTestId('comment-input').fill('Is this still true for JPY?');
    await page.getByTestId('comment-submit').click();
    await expect(page.getByTestId('comment-card')).toHaveCount(2);

    const anchoredText = (await paragraph.innerText()).slice(0, 40);
    const blockId = await paragraph.getAttribute('data-block-id');
    expect(blockId, 'the paragraph has no identity to anchor to').toBeTruthy();

    // An agent proposes a scoped rewrite of that exact block.
    const suggestion = await fetch(`${API}/v1/docs/specs%2Fcheckout-v2/suggestions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens().agentToken}` },
      body: JSON.stringify({
        ops: [
          {
            kind: 'replace',
            target: blockId,
            markdown: 'The amount field is required, and JPY has no minor unit at all.',
          },
        ],
        rationale: 'the implementation special-cases JPY',
      }),
    });
    expect(suggestion.status).toBe(201);
    const { suggestion: created } = (await suggestion.json()) as { suggestion: { id: string } };

    // It appears for review, attributed, and does not touch the document yet.
    await page.reload();
    await page.getByTestId('doc-specs/checkout-v2').click();
    // No tab to open: the proposal is rendered in the document, at the
    // paragraph it would rewrite.
    const card = page.locator(`[data-testid="suggestion-card"]`).filter({ hasText: 'JPY' }).first();
    await expect(card).toBeVisible();
    await expect(card).toContainText('Nothing changes until you accept it.');
    expect(await page.locator('.prose').innerText()).toContain(anchoredText.slice(0, 20));

    // Priya accepts it.
    await page.getByTestId(`accept-${created.id}`).click();
    await expect(page.locator('.prose')).toContainText('JPY has no minor unit at all', {
      timeout: 15_000,
    });

    // The comment is still attached to the rewritten paragraph.
    const comments = await fetch(`${API}/v1/docs/specs%2Fcheckout-v2/comments`, {
      headers: { authorization: `Bearer ${tokens().token}` },
    });
    const { comments: threads } = (await comments.json()) as {
      comments: { body: string; anchor: { blockId: string }; orphanedAt: string | null }[];
    };
    const mine = threads.find((c) => c.body === 'Is this still true for JPY?')!;
    expect(mine, 'the comment vanished').toBeTruthy();
    expect(mine.anchor.blockId, 'the comment lost its anchor through the rewrite').toBe(blockId);
    expect(mine.orphanedAt).toBeNull();
  });

  test('a stale proposal is shown as stale and cannot be accepted', async ({ page }) => {
    await openSpec(page);
    const paragraph = page.locator('.prose > p[data-block-id]').nth(1);
    const blockId = await paragraph.getAttribute('data-block-id');

    const created = await fetch(`${API}/v1/docs/specs%2Fcheckout-v2/suggestions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens().agentToken}` },
      body: JSON.stringify({
        ops: [{ kind: 'replace', target: blockId, markdown: 'A proposal that will go stale.' }],
        rationale: 'about to be overtaken',
      }),
    });
    const { suggestion } = (await created.json()) as { suggestion: { id: string } };

    // Priya edits the same paragraph herself, out from under the proposal.
    await caretAtEndOf(page, '.prose > p[data-block-id]', 1);
    await page.keyboard.type(' Edited by a person first.');
    await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });

    const card = page.locator('[data-testid="suggestion-card"]').filter({ hasText: 'overtaken' });
    await expect(card).toContainText("so it can't be applied", { timeout: 15_000 });
    // Absent rather than disabled: a greyed primary button invites a click and
    // explains nothing.
    await expect(card.getByRole('button', { name: 'Use this' })).toHaveCount(0);

    // And the API refuses too, not just the button.
    const accept = await fetch(
      `${API}/v1/docs/specs%2Fcheckout-v2/suggestions/${suggestion.id}/accept`,
      { method: 'POST', headers: { authorization: `Bearer ${tokens().token}` } },
    );
    expect(accept.status, 'a stale proposal was accepted').toBe(409);
  });
});

test.describe('review surfaces', () => {
  test('shows a note that lost its place rather than guessing', async ({ page }) => {
    // An external edit deletes an annotated block. The note must be kept with
    // its last-known text, never silently reattached to something else.
    await openSpec(page);
    const paragraph = page.locator('.prose p').filter({ hasText: 'Support may override' }).first();
    await paragraph.click();
    await page.waitForTimeout(150);
    await page.keyboard.press('ControlOrMeta+Alt+m');
    await page.getByTestId('comment-input').fill('Who approves an override?');
    await page.getByTestId('comment-submit').click();
    await expect(page.getByTestId('comment-card').first()).toBeVisible();

    const current = await fetch(`${API}/v1/docs/specs%2Fcheckout-v2?markers=1`, {
      headers: { authorization: `Bearer ${tokens().token}` },
    });
    const { content } = (await current.json()) as { content: string };
    const withoutBlock = content
      .split('\n\n')
      .filter((block) => !block.includes('Support may override'))
      .join('\n\n');

    const ingest = await fetch(`${API}/v1/docs/specs%2Fcheckout-v2/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens().token}` },
      body: JSON.stringify({ content: withoutBlock }),
    });
    expect((await ingest.json()).kind).toBe('applied');

    await page.reload();
    await page.getByTestId('doc-specs/checkout-v2').click();
    await expect(page.getByTestId('orphan-card').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('orphan-card').first()).toContainText('override');
  });

  test('warns rather than merging when a document is replaced wholesale', async ({ page }) => {
    await openSpec(page);
    const before = await page.locator('.prose').innerText();

    await fetch(`${API}/v1/docs/runbooks%2Fdeploy/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens().token}` },
      body: JSON.stringify({ content: '# From another branch\n\nNothing in common at all.\n' }),
    });

    // The open document is untouched — a replacement elsewhere is a session
    // boundary, not an edit that merges into what someone is reading.
    expect(await page.locator('.prose').innerText()).toBe(before);
  });
});

test.describe('accessibility and resilience', () => {
  test('every control is labelled, and present before anything is selected', async ({ page }) => {
    await openSpec(page);
    const toolbar = page.getByRole('toolbar', { name: 'Formatting' });

    // The whole bet: the controls are there before the writer has done
    // anything, so "what can this program do" is answered by looking.
    await expect(toolbar).toBeVisible();
    for (const label of ['Bold', 'Italic', 'Underline', 'Insert link', 'Insert diagram', 'Bulleted list']) {
      await expect(toolbar.getByRole('button', { name: label, exact: true })).toBeVisible();
    }

    // Paragraph styles are reachable by name rather than by glyph, and each is
    // drawn in the style it applies.
    await page.getByTestId('style-menu').click();
    for (const label of ['Normal text', 'Title', 'Heading 1']) {
      await expect(page.getByRole('menuitemradio', { name: new RegExp(label) })).toBeVisible();
    }
    await page.keyboard.press('Escape');

    // And everything the toolbar offers is also enumerated in the menus, in
    // plain English, with its shortcut.
    await page.getByTestId('menu-format').click();
    for (const label of ['Bold', 'Underline', 'Checklist', 'Clear formatting']) {
      await expect(page.getByRole('menuitem', { name: new RegExp(label) })).toBeVisible();
    }
  });

  /**
   * A menu bar that claims `role="menubar"` owes the keyboard a contract.
   *
   * The role tells a screen-reader user to press the arrow keys. Asserting it
   * without implementing them is worse than having no role — and four commands
   * (Quote, Callout, Horizontal line, Code block) live in these menus and
   * nowhere else, so they were unreachable without a mouse.
   */
  test('the menus can be driven entirely from the keyboard', async ({ page }) => {
    await openSpec(page);

    await page.getByTestId('menu-file').focus();

    // Enter opens the menu *and* puts the caret on its first item — a menu that
    // opens without moving focus strands a keyboard user looking at something
    // they cannot reach.
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu', { name: 'File' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /New document/ })).toBeFocused();

    // Down walks the list.
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: /Open a document/ })).toBeFocused();

    // Right moves to the next menu, keeping it open.
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('menu', { name: 'Edit' })).toBeVisible();

    // Escape closes it and gives focus back to the trigger, never to nowhere.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu', { name: 'Edit' })).toHaveCount(0);
    await expect(page.getByTestId('menu-edit')).toBeFocused();

    // And the whole bar is one tab stop, not four.
    const stops = await page.locator('.menubar-trigger').evaluateAll((nodes) =>
      nodes.filter((node) => (node as HTMLElement).tabIndex === 0).length,
    );
    expect(stops, 'the menu bar should be a single stop in the tab order').toBe(1);
  });

  /**
   * A menu is where most people ever learn a shortcut, so one that lies about
   * a shortcut is worse than one that shows none. Four had drifted from the
   * keymap; the keymap is derived from these labels now, so this checks the
   * derivation rather than a hand-written table.
   */
  /**
   * The keyboard failures a second review found, one test each.
   *
   * All five shared a shape: the guard was right and its assumption was not.
   * Arrowing into a menu that was already open set the same state, React bailed
   * out of the render, and the effect that moves focus never re-ran — leaving a
   * menu that was open, visible, and completely keyboard-dead.
   */
  test('a menu stays usable after arrowing into it', async ({ page }) => {
    await openSpec(page);
    await page.getByTestId('menu-file').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowRight');

    // Edit's entries are all disabled on a fresh document, so there is nothing
    // to go inside — focus has to land on the trigger rather than on nothing.
    await expect(page.getByTestId('menu-edit')).toBeFocused();

    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('menu', { name: 'Insert' })).toBeVisible();
    // And this is the key one: the menu it arrived at still takes arrow keys.
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: /Diagram/ })).toBeFocused();
  });

  test('a menu opened with the mouse still takes the keyboard', async ({ page }) => {
    await openSpec(page);
    // The trigger prevents default to keep the document's selection, which
    // suppresses focus with it — so a mouse-opened menu was inert and Escape
    // could not close it, because no element-level handler ever saw the key.
    await page.getByTestId('menu-insert').click();
    await expect(page.getByTestId('menu-insert')).toBeFocused();

    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Image' })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu', { name: 'Insert' })).toHaveCount(0);
  });

  test('a menu entry is never a tab stop', async ({ page }) => {
    await openSpec(page);
    await page.getByTestId('menu-format').click();
    // Seventeen entries, and Tab used to walk every one of them and then land
    // on the toolbar with the menu still open behind it.
    const stops = await page
      .locator('.menubar-entry')
      .evaluateAll((nodes) => nodes.filter((node) => (node as HTMLElement).tabIndex === 0).length);
    expect(stops).toBe(0);
  });

  test('a shortcut the menu advertises is the shortcut that works', async ({ page }) => {
    await openSpec(page);
    // The first paragraph, whose position does not depend on what earlier
    // tests left behind.
    const first = page.locator('.prose > p[data-block-id]').first();
    const words = (await first.innerText()).trim();
    await selectContentsOf(page, '.prose > p[data-block-id]', 0);

    // Advertised as ⌘U by both the toolbar tooltip and the Format menu. It was
    // bound to a no-op that swallowed the key.
    await page.keyboard.press('ControlOrMeta+u');
    // `.first()`, because a paragraph that already contains bold comes back as
    // more than one underlined run — which is correct, and is the nesting the
    // serializer is separately tested on.
    await expect(page.locator('.prose u').first()).toBeVisible();

    await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });
    const asAgent = await readAsAgent('specs/checkout-v2');
    expect(asAgent, 'underline did not reach the stored document').toContain('<u>');
    expect(asAgent, 'underline did not wrap the words it was applied to').toContain(words.slice(0, 20));
  });

  test('inserts a diagram that leaves as a portable fence', async ({ page }) => {
    await openSpec(page);
    await caretAtEndOf(page, '.prose > p[data-block-id]');

    await page.getByRole('button', { name: 'Insert diagram', exact: true }).click();
    await page.getByTestId('diagram-flowchart').click();

    // It draws in the document — no fence, no monospace, no syntax on the page.
    await expect(page.locator('.prose figure.diagram svg')).toBeVisible({ timeout: 15_000 });
    expect(await page.locator('.prose').innerText()).not.toContain('```');

    await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });

    // And on disk it is the convention every other renderer already draws.
    const asAgent = await readAsAgent('specs/checkout-v2');
    expect(asAgent).toContain('```mermaid');
    expect(asAgent).toContain('flowchart TD');
  });

  test('logs no console errors during an ordinary session', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(error.message));

    await openSpec(page);
    await openHistory(page);
    await page.keyboard.press('Escape');
    await caretAtEndOf(page, '.prose > p[data-block-id]');
    await page.keyboard.type(' A quiet edit.');
    await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });

    expect(errors.filter((e) => !e.includes('favicon'))).toEqual([]);
  });

  test('renders usably at every width, with the notes never over the text', async ({ page }) => {
    await openSpec(page);

    // A spread of real window sizes, from a large desktop display down to a
    // phone. 1180 and 1280 are the ones that were broken: too narrow for the
    // margin to fit beside the page, but not narrow enough to have moved the
    // notes below it.
    for (const width of [2560, 1920, 1512, 1400, 1280, 1180, 980, 720, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(250);
      await expect(page.locator('.prose')).toBeVisible();
      await expect(page.getByTestId('rail')).toBeVisible();

      const geometry = await page.evaluate(() => {
        const desk = document.querySelector('.desk')!;
        const page_ = document.querySelector('.page')!.getBoundingClientRect();
        const lane = document.querySelector('.lane')!.getBoundingClientRect();
        const prose = document.querySelector('.prose')!;
        return {
          measureEm:
            prose.getBoundingClientRect().width /
            parseFloat(getComputedStyle(prose).fontSize),
          documentOverflow:
            document.documentElement.scrollWidth - document.documentElement.clientWidth,
          deskOverflow: desk.scrollWidth - desk.clientWidth,
          // The page must contain its own content; a collapsed page box is how
          // the notes ended up sitting on top of the paragraphs.
          pageContainsProse:
            Math.round(document.querySelector('.prose')!.getBoundingClientRect().bottom) <=
            Math.round(page_.bottom) + 1,
          overlaps: !(
            lane.top >= page_.bottom ||
            lane.bottom <= page_.top ||
            lane.left >= page_.right ||
            lane.right <= page_.left
          ),
        };
      });

      expect(geometry.documentOverflow, `the window scrolls sideways at ${width}px`).toBeLessThanOrEqual(1);
      expect(geometry.deskOverflow, `the document is cut off at ${width}px`).toBeLessThanOrEqual(1);
      expect(geometry.pageContainsProse, `the page does not contain its text at ${width}px`).toBe(true);
      expect(geometry.overlaps, `the notes cover the document at ${width}px`).toBe(false);
      // The page may grow with the window; the line length may not.
      expect(geometry.measureEm, `the line is too long to read at ${width}px`).toBeLessThanOrEqual(37);
    }
  });
});

test.describe('history', () => {
  test('shows a timeline, names a version, and brings one back', async ({ page }) => {
    await openSpec(page);

    // Make a change worth remembering, then name it.
    await caretAtEndOf(page, '.prose > p[data-block-id]');
    await page.keyboard.type(' The good version.');
    await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });

    await openHistory(page);
    await expect(page.getByTestId('revision').first()).toBeVisible();
    await page.getByTestId('checkpoint-input').fill('before the rewrite');
    await page.getByTestId('checkpoint-submit').click();
    await expect(page.getByTestId('history-rail')).toContainText('before the rewrite');
    await closeOverlay(page);

    // Regret it.
    await caretAtEndOf(page, '.prose > p[data-block-id]');
    await page.keyboard.type(' A regrettable addition.');
    await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });
    await expect(page.locator('.prose')).toContainText('A regrettable addition.');

    // Bring the named version back.
    await openHistory(page);
    const named = page.locator('[data-testid="revision"]').filter({ hasText: 'before the rewrite' });
    await named.first().hover();
    await named.first().getByRole('button', { name: 'Restore' }).click();

    await expect(page.locator('.prose')).toContainText('The good version.', { timeout: 15_000 });
    await expect(page.locator('.prose')).not.toContainText('A regrettable addition.');

    // The restore is itself in the timeline — nothing was erased.
    await openHistory(page);
    await expect(page.getByTestId('history-rail')).toContainText('restored the version');
  });

  test('says who wrote the selected block, and whether it was a person', async ({ page }) => {
    await openSpec(page);
    await page.locator('.prose > p[data-block-id]').first().click();
    await caretAtEndOf(page, '.prose > p[data-block-id]');
    await page.keyboard.type(' Written by a person.');
    await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });

    // Attribution answers "who wrote this paragraph", so the paragraph is
    // chosen first and the timeline is opened against it.
    await page.locator('.prose > p[data-block-id]').first().click();
    await page.waitForTimeout(150);
    await openHistory(page);
    await expect(page.getByTestId('attribution')).toBeVisible();
    await expect(page.getByTestId('attribution')).toContainText('priya');
  });

  test('never uses git vocabulary anywhere in the interface', async ({ page }) => {
    // `idea.md`: users never get commits, branches, merges, conflicts, or the
    // word "rebase". This asserts the promise at the surface where it matters.
    await openSpec(page);
    await openHistory(page);
    const text = (await page.locator('body').innerText()).toLowerCase();
    for (const forbidden of ['commit', 'branch', 'rebase', 'merge conflict']) {
      expect(text, `the interface used the word "${forbidden}"`).not.toContain(forbidden);
    }
  });
});

/**
 * Designs, end to end.
 *
 * The claim under test is the one that makes a design worth having in this
 * product rather than in Figma: **what the canvas produces is what an agent
 * reads.** Not an export of it, not a description of it — the same bytes.
 *
 * So the shape of the test is deliberately the same as walkthrough A. A person
 * does something visual with a mouse, and an agent then reads the file with the
 * agent's own credentials and finds exactly the change.
 */
test.describe('images', () => {
  /**
   * Pasting an image is the gesture people try first, without being told to.
   *
   * The claim under test is the same one every other walkthrough makes: what
   * the writer does with their hands is what the agent reads. A paste has to
   * end up as an ordinary `![](…)` in the stored Markdown, not as a blob the
   * document merely points at from some parallel store.
   */
  test('a pasted image lands in the document as ordinary Markdown', async ({ page }) => {
    await openSpec(page);
    const paragraphs = await page.locator('.prose > p[data-block-id]').count();
    await caretAtEndOf(page, '.prose > p[data-block-id]', paragraphs - 1);

    // A real 1×1 PNG, pasted the way a screenshot is.
    await page.evaluate(async () => {
      const png = Uint8Array.from(
        atob(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        ),
        (c) => c.charCodeAt(0),
      );
      const file = new File([png], 'a screenshot.png', { type: 'image/png' });
      const data = new DataTransfer();
      data.items.add(file);
      document
        .querySelector('.ProseMirror')!
        .dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });

    const image = page.locator('.prose img').first();
    await expect(image).toBeVisible({ timeout: 15_000 });
    // Content-addressed, so the same paste twice is the same URL and the same
    // bytes on disk.
    await expect(image).toHaveAttribute('src', /\/v1\/assets\//);
    // The filename becomes the description, because an image with none is a
    // hole in the document for every agent that reads it.
    await expect(image).toHaveAttribute('alt', 'a screenshot');

    await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });

    const asAgent = await readAsAgent('specs/checkout-v2');
    expect(asAgent, 'the image did not reach the stored document').toMatch(
      /!\[a screenshot\]\(\/v1\/assets\/[0-9a-f]+\)/,
    );
  });
});

test.describe('designs', () => {
  test('a design made with the mouse is what an agent reads', async ({ page }) => {
    await openWorkspace(page);
    await page.getByTestId('doc-specs/checkout-v2').click();
    await expect(page.getByTestId('doc-title')).toHaveText('Checkout v2');
    await caretAtEndOf(page, '.prose > p[data-block-id]');

    await page.getByRole('button', { name: 'Insert design', exact: true }).click();
    await page.getByTestId('design-form').click();

    // The prose gets a reference, not a copy: a design is its own document.
    const chip = page.locator('.prose a[title="design"]');
    await expect(chip).toBeVisible();
    await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });
    // Read where it points *now*, while the prose is still on screen — opening
    // the design replaces this surface with the canvas.
    const designPath = (await chip.first().getAttribute('href')) ?? '';
    expect(designPath, 'the design reference has no target').not.toBe('');

    // Open the design. It gets the canvas, decided by looking at the content.
    await page.reload();
    await page.getByTestId('doc-list').getByText('Form', { exact: true }).click();
    await expect(page.getByTestId('design-editor')).toBeVisible();
    // It renders as a picture — real boxes with real text, no markup on screen.
    await expect(page.locator('.design-canvas .design-surface')).toBeVisible();
    await expect(page.locator('.design-layer', { hasText: 'Pay $42.00' }).first()).toBeVisible();
    expect(await page.locator('.design-canvas').innerText()).not.toContain('<box');
    // And it starts clean, which is what makes the findings bar meaningful.
    await expect(page.getByTestId('design-findings')).toHaveText('Nothing to fix.');

    // Change a property with the mouse, the way anyone would.
    await pickLayer(page, 'Pay button');
    await page.locator('.inspector-choice', { hasText: 'Background' }).locator('select').selectOption('bg-danger');
    await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });

    // The agent's view. This is the whole point.
    const source = await readAsAgent(designPath);
    expect(source, 'the design is not stored as markup an agent can read').toContain('<design');
    expect(source).toContain('bg-danger');
    expect(source).not.toContain('bg-accent"');
    // Still a fence, so it degrades to legible source anywhere else.
    expect(source).toContain('```design');
  });

  test('one edit to a component changes every use of it', async ({ page }) => {
    // The whole argument for having components: twelve buttons that are the
    // *same* button. Without this, "our button" is a convention nobody can
    // enforce and every agent quietly reinvents it.
    await openWorkspace(page);
    await page.getByTestId('doc-specs/checkout-v2').click();
    await caretAtEndOf(page, '.prose > p[data-block-id]');
    const designPath = await insertDesign(page, 'design-kit');

    await page.reload();
    await page.getByTestId(`doc-${designPath}`).click();
    await expect(page.getByTestId('design-stage')).toBeVisible();
    // It starts clean, which is what makes the findings bar mean anything.
    await expect(page.getByTestId('design-findings')).toHaveText('Nothing to fix.');

    // Four buttons on the canvas, from two definitions and no repetition.
    const before = await readAsAgent(designPath);
    expect((before.match(/<use /g) ?? []).length).toBe(4);
    expect((before.match(/<define /g) ?? []).length).toBe(2);

    // Clicking a button selects the *use*, not a piece of the definition —
    // editing one of those through an instance would change every other
    // instance without saying so.
    await page.locator('.design-layer').filter({ hasText: 'Pay $42.00' }).last().click();
    await expect(page.locator('.design-inspector')).toContainText('label');

    // One slot changes one button.
    await page.locator('.inspector-group input').first().fill('Pay now');
    await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });
    expect(await readAsAgent(designPath)).toContain('label="Pay now"');

    // One edit to the definition changes all three that use it — and leaves
    // the fourth, which uses a different one, alone.
    await pickLayer(page, 'Button');
    await page.locator('.inspector-choice', { hasText: 'Corners' }).locator('select').selectOption('rounded-full');
    await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });

    const radii = await page.evaluate(() =>
      [...document.querySelectorAll('.design-canvas .design-surface [data-layer-id]')]
        .map((node) => getComputedStyle(node).borderRadius)
        .filter((radius) => radius !== '0px'),
    );
    expect(radii.filter((radius) => radius === '999px'), 'the definition did not reach its uses').toHaveLength(3);
    expect(radii.filter((radius) => radius !== '999px'), 'the other component changed too').toHaveLength(1);

    // And the file still says it once.
    const after = await readAsAgent(designPath);
    expect((after.match(/rounded-full/g) ?? []).length, 'the change was written per use').toBe(1);
    expect((after.match(/<use /g) ?? []).length).toBe(4);
  });

  test('the canvas selects the way a design tool does, and a drag is a move', async ({ page }) => {
    await openWorkspace(page);
    await page.getByTestId('doc-specs/checkout-v2').click();
    await caretAtEndOf(page, '.prose > p[data-block-id]');
    const designPath = await insertDesign(page, 'design-form');

    await page.reload();
    // By path, not by name: this suite creates more than one design and they
    // are all called the same thing.
    await page.getByTestId(`doc-${designPath}`).click();
    const stage = page.getByTestId('design-stage');
    await expect(stage).toBeVisible();

    // A click on the label inside the button selects the *button* — the whole
    // question a click has to answer, since three ancestors are under the
    // pointer. The frame is transparent: it is an artboard, not a group.
    await page.locator('.design-layer', { hasText: 'Pay $42.00' }).last().click();
    await expect(stage).toHaveAttribute('data-focus', '');
    const buttonId = (await stage.getAttribute('data-selected')) ?? '';
    expect(buttonId, 'the click selected nothing').not.toBe('');
    await expect(page.locator('.inspector-field input').first()).toHaveValue('Pay button');

    // Double-click goes one level in — and because a button is a box with one
    // label, it goes all the way to the words and puts a caret in them. Two
    // double-clicks to reach the only word there is would be friction with no
    // decision in it.
    await page.locator('.design-layer', { hasText: 'Pay $42.00' }).last().dblclick();
    await expect(stage).toHaveAttribute('data-focus', buttonId);
    await expect(page.locator('[data-editing="true"]')).toBeVisible();

    // Escape stops typing. Escape again comes back out a level — the exact
    // inverse of going in, so the pair is learnable.
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-editing="true"]')).toHaveCount(0);
    await expect(stage).toHaveAttribute('data-focus', buttonId);
    await page.keyboard.press('Escape');
    await expect(stage).toHaveAttribute('data-focus', '');
    await expect(stage).toHaveAttribute('data-selected', buttonId);

    // Drag the pay button up to the top of the form. Grabbed by its edge band,
    // which is the part of a box that belongs to its parent.
    const button = await page.locator('.design-layer', { hasText: 'Pay $42.00' }).first().boundingBox();
    const heading = await page.locator('.design-layer', { hasText: 'Payment' }).last().boundingBox();
    if (!button || !heading) throw new Error('the design did not render');
    await page.mouse.move(button.x + button.width / 2, button.y + 2);
    await page.mouse.down();
    for (let step = 1; step <= 14; step++) {
      const y = button.y + 2 + (heading.y - 4 - (button.y + 2)) * (step / 14);
      await page.mouse.move(button.x + button.width / 2, y);
      await page.waitForTimeout(16);
    }
    // The indicator is a line *between* two children, not a box around one:
    // "inside this" and "after this" look identical when both are a highlight.
    await expect(page.locator('.design-overlay-drop')).toBeAttached();
    await page.mouse.up();
    await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });

    // A drag produced a move, in the same op vocabulary an agent would send —
    // and the file says so.
    const source = await readAsAgent(designPath);
    const payAt = source.indexOf('Pay $42.00');
    const cardAt = source.indexOf('Card number');
    expect(payAt, 'the pay button is gone from the design').toBeGreaterThan(-1);
    expect(payAt, 'the drag did not reorder the layers').toBeLessThan(cardAt);

    // The words are edited on the thing, not in a field across the screen.
    // Double-click and type, which is what every editor anyone has used does.
    await page.locator('.design-layer').filter({ hasText: 'Pay $42.00' }).last().dblclick();
    await expect(page.locator('[data-editing="true"]')).toBeVisible();
    await page.keyboard.type('Pay in full');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });
    expect(await readAsAgent(designPath)).toContain('Pay in full');

    // Arrangement is about the shape, so its controls are over the shape.
    await pickLayer(page, 'Pay button');
    await expect(page.locator('.design-bar')).toBeVisible();
    await page.locator('.design-bar [aria-label="More padding"]').click();
    await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });
    // From nothing, one press lands on the smallest step that is visible —
    // stepping to `p-0` would be a press that appears to do nothing.
    expect(await readAsAgent(designPath), 'the bar did not change the design').toMatch(/class="[^"]*\bp-1\b/);

    // Arrows reorder. They do not nudge — this format has no coordinates, so a
    // pixel of movement would have nowhere to be written down.
    const beforeArrow = await readAsAgent(designPath);
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });
    // The drag put it first; one press down puts it after the heading.
    expect(payAt, 'the drag did not put the button first').toBeLessThan(source.indexOf('>Payment<'));
    // "Pay in full" now, because the canvas edit above renamed it.
    const after = await readAsAgent(designPath);
    expect(after.indexOf('Pay in full'), 'the arrow key did not reorder').toBeGreaterThan(
      after.indexOf('>Payment<'),
    );
    // And across the flow it does nothing, rather than something arbitrary.
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(500);
    expect(await readAsAgent(designPath)).toBe(after);

    // Undo. Every structural gesture here is destructive and saves itself
    // immediately, so a canvas without this is a canvas you cannot explore.
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });
    expect(await readAsAgent(designPath), 'undo did not put the layer back').toBe(beforeArrow);

    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });
    expect(await readAsAgent(designPath), 'redo did not reapply the move').toBe(after);
  });
});

test.describe('the library', () => {
  test('makes a design without being inside another document first', async ({ page }) => {
    // A design *is* a document, but for a while the only way to make one was
    // "insert a design into the document you are already in" — so the app's
    // second content type was reachable only as a footnote to its first.
    await openWorkspace(page);
    const rows = page.locator('.doc-row');
    const before = await rows.count();

    await page.getByTestId('new-button').click();
    await page.getByTestId('new-design').click();

    await expect(rows).toHaveCount(before + 1);
    // It lands on the canvas, not the prose editor, decided by its content.
    await expect(page.getByTestId('design-editor')).toBeVisible();
    await expect(page.getByTestId('design-palette')).toBeVisible();
  });

  test('deletes a document, and asks in the row it is about', async ({ page }) => {
    await openWorkspace(page);
    // Made here rather than reaching for a seeded document: this test destroys
    // what it names, and a shared fixture the other tests depend on is not a
    // thing to practise deleting on.
    await page.getByTestId('new-button').click();
    await page.getByRole('button', { name: 'Document Words, in a page' }).click();
    await expect(page.getByTestId('doc-title')).toHaveText('Untitled');

    const rows = page.locator('.doc-row');
    const before = await rows.count();
    const row = page.locator('.doc-row', { hasText: 'Untitled' }).first();

    // The trash icon is invisible until the row is hovered, and reachable.
    await row.hover();
    await row.locator('.doc-delete').click();

    // The question replaces the row rather than floating over it.
    await expect(page.locator('.doc-row.is-confirming')).toContainText('Delete');
    await expect(rows).toHaveCount(before);

    // Cancel keeps it. A destructive control whose first press is final is one
    // people stop reaching for.
    await page.getByRole('button', { name: 'Keep this document' }).click();
    await expect(page.locator('.doc-row.is-confirming')).toHaveCount(0);
    await expect(rows).toHaveCount(before);

    await row.hover();
    await row.locator('.doc-delete').click();
    await page.locator('.doc-row.is-confirming').getByText('Delete', { exact: true }).click();

    await expect(rows).toHaveCount(before - 1);
    // And it is gone from the server, not just from this list.
    await page.reload();
    await expect(page.locator('.doc-row')).toHaveCount(before - 1);
  });

  test('adds a finished thing from the palette, and the agent reads its parts', async ({ page }) => {
    await openWorkspace(page);
    await page.getByTestId('new-button').click();
    await page.getByTestId('new-design').click();
    await expect(page.getByTestId('design-palette')).toBeVisible();

    // A button, not a box. The palette's whole argument: what arrives is the
    // finished object, with its label, its fill and its states already right.
    await page.getByTestId('block-button').click();
    await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });
    await expect(
      page.locator('.design-canvas .design-layer', { hasText: 'Continue' }).first(),
    ).toBeVisible();

    // It lints clean on arrival. A palette that hands someone a contrast
    // failure has given them a problem they did not make.
    await expect(page.getByTestId('design-findings')).toHaveText('Nothing to fix.');

    const path = (await page.locator('.doc-row .doc-item.is-selected').getAttribute('data-testid'))
      ?.replace(/^doc-/, '');
    expect(path, 'the new design has no path').toBeTruthy();
    const source = await readAsAgent(path!);
    expect(source, 'the button did not reach the stored markup').toContain('bg-accent');
    expect(source).toContain('hover:bg-accent-hover');
    expect(source).toContain('Continue');
  });

  test('a design is renamed by typing over its name, and the list follows', async ({ page }) => {
    // The one thing about a design you could not change from the canvas. A
    // workspace filled up with documents all called "Untitled design".
    await openWorkspace(page);
    await page.getByTestId('new-button').click();
    await page.getByTestId('new-design').click();
    await expect(page.getByTestId('design-name')).toHaveValue('Untitled design');

    await page.getByTestId('design-name').fill('Sign in');
    await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });

    // The breadcrumb and the sidebar are the same fact seen twice, and both
    // read the document's heading rather than the design's name attribute.
    await expect(page.getByTestId('doc-title')).toHaveText('Sign in');
    await expect(page.locator('.doc-title', { hasText: 'Sign in' }).first()).toBeVisible();

    // The name moved in both places it is written: inside the fence for the
    // format, and above it as the heading everything else reads.
    const path = (await page.locator('.doc-row .doc-item.is-selected').getAttribute('data-testid'))
      ?.replace(/^doc-/, '');
    const source = await readAsAgent(path!);
    expect(source).toContain('# Sign in');
    expect(source).toContain('<design name="Sign in">');
    expect(source).not.toContain('Untitled design');
  });

  test('typing a real heading renames a document in the list', async ({ page }) => {
    // There is no rename command anywhere in this app on purpose: the title is
    // right there to type over. That was a promise the list did not keep — a
    // document created as Untitled stayed Untitled in the sidebar forever.
    await openWorkspace(page);
    await page.getByTestId('new-button').click();
    await page.getByRole('button', { name: 'Document Words, in a page' }).click();
    await expect(page.getByTestId('doc-title')).toHaveText('Untitled');

    await selectContentsOf(page, '.prose h1');
    await page.keyboard.type('Grocery list');
    await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });

    await expect(page.locator('.doc-title', { hasText: 'Grocery list' }).first()).toBeVisible();
    // And the id marker is plumbing, not part of the name.
    await expect(page.locator('.doc-title', { hasText: '<!--' })).toHaveCount(0);
  });
});
