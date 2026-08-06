/**
 * Rendering diagrams.
 *
 * Mermaid is a large dependency and most documents contain no diagram at all,
 * so it is loaded on first use and never as part of the initial bundle. The
 * module keeps three things the rest of the editor should not have to know
 * about:
 *
 * - **One initialization.** `mermaid.initialize` is global state; calling it per
 *   render is both wasteful and a way for two diagrams to disagree about the
 *   theme mid-document.
 * - **Errors that stay inside the figure.** Mermaid's default failure mode is to
 *   append its own error graphic to `document.body` and leave it there. Every
 *   render here is validated with `parse` first and the DOM is swept afterwards,
 *   because a stray red "Syntax error" box floating over the page is a bug the
 *   writer cannot dismiss.
 * - **A cache.** Rendering is asynchronous and comparatively slow; a NodeView
 *   that re-rendered on every transaction would flicker on every keystroke
 *   elsewhere in the document.
 */

/** Result of an attempted render. */
export type DiagramRender =
  | { readonly ok: true; readonly svg: string }
  | { readonly ok: false; readonly message: string; readonly line: number | null };

type Mermaid = typeof import('mermaid').default;

let mermaidPromise: Promise<Mermaid> | null = null;
let renderCounter = 0;

/** Whether the page is currently being shown dark, for the diagram's theme. */
function prefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
}

/**
 * The document's own colours, read off the stylesheet.
 *
 * A diagram drawn in mermaid's default lavender sits in a Galley document like
 * a screenshot of a different product. Reading the palette from CSS rather than
 * duplicating it here means the two cannot drift, and it is the reason the
 * theme is `base` — it is the only built-in one that accepts overrides.
 *
 * Every value must be a hex colour: mermaid's theme engine derives shades
 * arithmetically and silently produces black for anything it cannot parse.
 */
function palette(): Record<string, string> {
  const fallback = prefersDark()
    ? { line: '#3a3f47', ink: '#e8e6e1', fill: '#1d2026', accent: '#4fb394', page: '#17191d' }
    : { line: '#cfcabe', ink: '#1a1c1f', fill: '#f7f5f1', accent: '#1d6b58', page: '#ffffff' };
  if (typeof window === 'undefined') return themeVars(fallback);

  const styles = getComputedStyle(document.documentElement);
  const read = (name: string, backup: string): string => {
    const value = styles.getPropertyValue(name).trim();
    return /^#[0-9a-f]{3,8}$/i.test(value) ? value : backup;
  };
  return themeVars({
    line: read('--line-strong', fallback.line),
    ink: read('--text', fallback.ink),
    fill: read('--surface', fallback.fill),
    accent: read('--accent', fallback.accent),
    page: read('--page', fallback.page),
  });
}

function themeVars(colors: { line: string; ink: string; fill: string; accent: string; page: string }): Record<string, string> {
  return {
    background: colors.page,
    primaryColor: colors.fill,
    primaryTextColor: colors.ink,
    primaryBorderColor: colors.line,
    secondaryColor: colors.page,
    tertiaryColor: colors.fill,
    lineColor: colors.line,
    textColor: colors.ink,
    mainBkg: colors.fill,
    nodeBorder: colors.line,
    clusterBkg: colors.page,
    clusterBorder: colors.line,
    titleColor: colors.ink,
    edgeLabelBackground: colors.page,
    actorBkg: colors.fill,
    actorBorder: colors.line,
    actorTextColor: colors.ink,
    signalColor: colors.ink,
    signalTextColor: colors.ink,
    labelBoxBkgColor: colors.fill,
    labelBoxBorderColor: colors.line,
    noteBkgColor: colors.fill,
    noteBorderColor: colors.line,
    noteTextColor: colors.ink,
    pie1: colors.accent,
  };
}

async function load(): Promise<Mermaid> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((module) => {
      const mermaid = module.default;
      mermaid.initialize({
        startOnLoad: false,
        /**
         * The single most important line in this file.
         *
         * Mermaid's default failure mode is to draw its own "Syntax error"
         * graphic straight into the live DOM, outside anything we handed it.
         * Inside ProseMirror that is not cosmetic: the view's MutationObserver
         * sees foreign nodes appear inside the editor and either parses them
         * into the document or throws. A writer's half-typed diagram would
         * corrupt their file.
         */
        suppressErrorRendering: true,
        // The diagram source arrives from a document that an agent may have
        // written. `strict` is what stops a `click` directive or an embedded
        // script tag in that source from executing in the writer's session.
        // It is also the level a 2025 advisory (CVE-2025-54881) showed to be
        // bypassable before 11.10 — hence the floor in `package.json`.
        securityLevel: 'strict',
        // `base` is the only built-in theme that accepts overrides, and the
        // overrides are the document's own palette — a diagram drawn in
        // mermaid's default lavender sits in a Galley page like a screenshot of
        // a different product.
        theme: 'base',
        themeVariables: palette(),
        darkMode: prefersDark(),
        fontFamily: 'ui-sans-serif, -apple-system, Inter, Segoe UI, Roboto, sans-serif',
        flowchart: { htmlLabels: true, curve: 'basis' },
        // Mermaid otherwise logs parse failures to the console at error level,
        // and a writer's typo is not a program error.
        logLevel: 'fatal',
      });
      // A global hook mermaid calls on every parse failure. Left at its default
      // it writes to the console, which turns ordinary mid-typing states into a
      // wall of red for anyone with devtools open.
      mermaid.parseError = () => {};
      return mermaid;
    });
  }
  return mermaidPromise;
}

/**
 * Drop the theme decision and force the next render to re-initialize.
 *
 * Mermaid bakes colours into the SVG it emits, so a document open across a
 * system theme change has to be re-*rendered* rather than restyled. Clearing
 * the cache alone is not enough — a diagram already on screen has already been
 * drawn, so every view has to be told to draw again.
 */
export function resetDiagramTheme(): void {
  mermaidPromise = null;
  cache.clear();
  for (const listener of themeListeners) listener();
}

const themeListeners = new Set<() => void>();

/** Ask to be told when every diagram needs redrawing. */
export function onDiagramThemeChange(listener: () => void): () => void {
  themeListeners.add(listener);
  return () => themeListeners.delete(listener);
}

// The system theme is the one thing that invalidates every rendered diagram at
// once. `initialize` is global and runs exactly once, so without this a
// document open across a theme change keeps light-palette diagrams forever --
// including ones inserted afterwards.
if (typeof window !== 'undefined' && window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => resetDiagramTheme());
}

const cache = new Map<string, DiagramRender>();
/** Bounded so a long editing session cannot grow it without limit. */
const CACHE_LIMIT = 120;

function remember(key: string, value: DiagramRender): DiagramRender {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
  return value;
}

/**
 * Mermaid's own message, rewritten for someone who did not choose to be
 * looking at a parser error.
 *
 * The raw text is a parser expectation list — "Expecting 'SPACE', 'GRAPH', got
 * 'ALPHA'" — which tells a writer nothing. The line number is the part worth
 * keeping, because it is the part they can act on.
 */
function explain(error: unknown): { message: string; line: number | null } {
  const raw = error instanceof Error ? error.message : String(error);
  const lineMatch = /line (\d+)/i.exec(raw) ?? /Parse error on line (\d+)/i.exec(raw);
  const line = lineMatch ? Number(lineMatch[1]) : null;
  if (/no diagram type detected|^Parse error/i.test(raw) && !line) {
    return { message: 'This does not look like a diagram yet. Pick a type on the first line.', line: null };
  }
  return {
    message: line
      ? `Line ${line} is not something this diagram type understands.`
      : 'This diagram could not be drawn. Check the first line for its type.',
    line,
  };
}

/**
 * Remove anything mermaid left behind outside the element we asked it to fill.
 *
 * `render` creates a detached measuring node and, on failure, an error graphic;
 * both are keyed off the id it was given, and neither is cleaned up reliably.
 */
function sweep(id: string): void {
  if (typeof document === 'undefined') return;
  for (const stray of document.querySelectorAll(`#${CSS.escape(id)}, #${CSS.escape(`d${id}`)}`)) {
    stray.remove();
  }
}

export async function renderDiagram(lang: string, code: string): Promise<DiagramRender> {
  const key = `${prefersDark() ? 'dark' : 'light'} ${lang} ${code}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const trimmed = code.trim();
  if (!trimmed) {
    return remember(key, { ok: false, message: 'This diagram is empty.', line: null });
  }

  let mermaid: Mermaid;
  try {
    mermaid = await load();
  } catch {
    return { ok: false, message: 'The diagram renderer could not be loaded.', line: null };
  }

  // A deterministic, document-unique id. Mermaid uses it for the SVG's own id
  // and for every internal `url(#…)` reference, so two diagrams sharing one
  // would make the second inherit the first's arrowheads.
  const id = `galley-diagram-${++renderCounter}`;
  try {
    // Validate first, and separately. `parse` with `suppressErrors` returns
    // `false` rather than throwing and — unlike `render` — never appends
    // anything to the page at all. `suppressErrorRendering` above makes the
    // second line safe too; both are here because either alone is one config
    // regression away from writing into the document.
    const parsed = await mermaid.parse(trimmed, { suppressErrors: true }).catch(() => false as const);
    if (parsed === false) {
      return remember(key, {
        ok: false,
        message: 'This diagram is not finished yet.',
        line: null,
      });
    }
    const { svg } = await mermaid.render(id, trimmed);
    return remember(key, { ok: true, svg });
  } catch (error) {
    return remember(key, { ok: false, ...explain(error) });
  } finally {
    sweep(id);
  }
}

// ---------------------------------------------------------------------------
// Starting points
// ---------------------------------------------------------------------------

/**
 * The Insert menu's diagram choices.
 *
 * A writer who has never seen Mermaid cannot start from a blank box, and the
 * product's whole premise is that they should not have to learn a syntax to get
 * a picture. Each of these is a working diagram with real placeholder labels —
 * the first edit is renaming a box, not discovering a grammar.
 */
export interface DiagramTemplate {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly code: string;
}

export const DIAGRAM_TEMPLATES: readonly DiagramTemplate[] = [
  {
    id: 'flowchart',
    label: 'Flowchart',
    hint: 'Boxes and arrows',
    code: ['flowchart TD', '  Start([Start]) --> Step[Do the thing]', '  Step --> Check{Worked?}', '  Check -- Yes --> Done([Done])', '  Check -- No --> Step'].join('\n'),
  },
  {
    id: 'sequence',
    label: 'Sequence',
    hint: 'Who calls whom, in order',
    code: ['sequenceDiagram', '  participant Person', '  participant Service', '  Person->>Service: Asks for something', '  Service-->>Person: Answers'].join('\n'),
  },
  {
    id: 'timeline',
    label: 'Timeline',
    hint: 'Events along a line',
    code: ['timeline', '  title Project timeline', '  Week 1 : Kickoff', '  Week 2 : Draft : Review', '  Week 3 : Ship'].join('\n'),
  },
  {
    id: 'pie',
    label: 'Pie chart',
    hint: 'Parts of a whole',
    code: ['pie title Where the time went', '  "Building" : 45', '  "Reviewing" : 30', '  "Meetings" : 25'].join('\n'),
  },
  {
    id: 'state',
    label: 'States',
    hint: 'What can become what',
    code: ['stateDiagram-v2', '  [*] --> Draft', '  Draft --> InReview: Submit', '  InReview --> Draft: Changes asked', '  InReview --> Published: Approve', '  Published --> [*]'].join('\n'),
  },
  {
    id: 'gantt',
    label: 'Schedule',
    hint: 'Bars across dates',
    code: ['gantt', '  title Schedule', '  dateFormat YYYY-MM-DD', '  section Phase one', '  Research :a1, 2026-01-06, 7d', '  Build :after a1, 14d'].join('\n'),
  },
];
