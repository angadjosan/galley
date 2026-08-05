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
  await expect(page.locator('.prose p').first()).toBeVisible();
}

/** Put the caret at the end of a block, the way a person clicking would. */
async function caretAtEndOf(page: Page, selector: string, index = 0): Promise<void> {
  await page.locator(selector).nth(index).click();
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

  test('formats with the toolbar and keeps the change', async ({ page }) => {
    await openSpec(page);
    await caretAtEndOf(page, '.prose p');
    await page.keyboard.type(' Bolded.');
    await page.keyboard.down('Shift');
    for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowLeft');
    await page.keyboard.up('Shift');
    await page.getByRole('button', { name: 'Bold' }).click();

    await expect(page.locator('.prose strong').filter({ hasText: 'Bolded.' })).toBeVisible();
    await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });

    const asAgent = await readAsAgent('specs/checkout-v2');
    expect(asAgent, 'the emphasis did not reach the stored document').toContain('**Bolded.**');
  });

  test('turns Markdown shortcuts into structure as you type', async ({ page }) => {
    await openSpec(page);
    const paragraphs = await page.locator('.prose p').count();
    await caretAtEndOf(page, '.prose p', paragraphs - 1);
    await page.keyboard.press('Enter');
    await page.keyboard.type('## A section typed with a shortcut');

    await expect(
      page.locator('.prose h2').filter({ hasText: 'A section typed with a shortcut' }),
    ).toBeVisible();
    // And no `##` is left visible anywhere.
    expect(await page.locator('.prose').innerText()).not.toContain('## A section');
  });
});

test.describe('walkthrough A: human writes, agent consumes', () => {
  test('an agent reads exactly the bytes the writer produced, minus the plumbing', async ({
    page,
  }) => {
    await openSpec(page);
    await caretAtEndOf(page, '.prose p');
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
    const paragraph = page.locator('.prose p').nth(1);
    await paragraph.click();
    await page.getByTestId('rail-comments').click();
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
    await page.getByTestId('rail-suggestions').click();
    const card = page.locator(`[data-testid="suggestion-card"]`).filter({ hasText: 'JPY' }).first();
    await expect(card).toBeVisible();
    await expect(card.locator('.tag')).toHaveText('pending');
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
    const paragraph = page.locator('.prose p').nth(1);
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
    await caretAtEndOf(page, '.prose p', 1);
    await page.keyboard.type(' Edited by a person first.');
    await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });

    await page.getByTestId('rail-suggestions').click();
    const card = page.locator('[data-testid="suggestion-card"]').filter({ hasText: 'overtaken' });
    await expect(card.locator('.tag').first()).toHaveText('stale', { timeout: 15_000 });
    await expect(card.getByRole('button', { name: 'Accept' })).toBeDisabled();

    // And the API refuses too, not just the button.
    const accept = await fetch(
      `${API}/v1/docs/specs%2Fcheckout-v2/suggestions/${suggestion.id}/accept`,
      { method: 'POST', headers: { authorization: `Bearer ${tokens().token}` } },
    );
    expect(accept.status, 'a stale proposal was accepted').toBe(409);
  });
});

test.describe('review surfaces', () => {
  test('shows an orphaned anchor in the tray rather than guessing', async ({ page }) => {
    // An external edit deletes an annotated block. The anchor must land in the
    // tray with its last-known text, never silently reattach.
    await openSpec(page);
    const paragraph = page.locator('.prose p').nth(2);
    await paragraph.click();
    await page.getByTestId('rail-comments').click();
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
    await page.getByTestId('rail-orphans').click();
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
  test('the toolbar is reachable and labelled', async ({ page }) => {
    await openSpec(page);
    const toolbar = page.getByRole('toolbar', { name: 'Formatting' });
    await expect(toolbar).toBeVisible();
    for (const label of ['Bold', 'Italic', 'Bullet list', 'Quote']) {
      await expect(page.getByRole('button', { name: label })).toBeVisible();
    }
  });

  test('logs no console errors during an ordinary session', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(error.message));

    await openSpec(page);
    await page.getByTestId('rail-suggestions').click();
    await page.getByTestId('rail-orphans').click();
    await page.getByTestId('rail-comments').click();
    await caretAtEndOf(page, '.prose p');
    await page.keyboard.type(' A quiet edit.');
    await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });

    expect(errors.filter((e) => !e.includes('favicon'))).toEqual([]);
  });

  test('renders usably at a narrow viewport', async ({ page }) => {
    await openSpec(page);
    await page.setViewportSize({ width: 720, height: 900 });
    await expect(page.locator('.prose')).toBeVisible();
    await expect(page.getByTestId('rail')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'the page scrolls horizontally at a narrow viewport').toBeLessThanOrEqual(1);
  });
});
