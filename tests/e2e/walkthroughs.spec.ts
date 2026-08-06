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

/** History is a destination now, not a permanent tab. It lives under File. */
async function openHistory(page: Page): Promise<void> {
  await page.getByTestId('menu-file').click();
  await page.getByRole('menuitem', { name: 'Version history' }).click();
  await expect(page.getByTestId('history-rail')).toBeVisible();
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
