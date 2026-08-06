/**
 * What a design is.
 *
 * The whole feature rests on one decision — what a design's *source of truth*
 * looks like — so it is worth stating the answer and the reasoning here rather
 * than leaving it implied by the parser.
 *
 * **A design is a web page with the cascade removed.** A small tree of boxes,
 * text and images, laid out by flexbox, where every node carries its complete
 * style inline as a restricted set of utility class names, and every value is
 * a token reference rather than a literal.
 *
 * The four properties that follow from that, in the order they matter:
 *
 * 1. **An edit is local.** No selectors, no cascade, no stylesheet, so changing
 *    one layer changes one line. That is the precondition for the same splicing
 *    guarantee the prose engine makes — and the reason unrestricted HTML+CSS
 *    lost: with a cascade, the effect of an edit depends on the whole document.
 * 2. **A model can write it.** Utility class names are the most widely trained
 *    design vocabulary that exists. That matters more than elegance: the
 *    measured gap between a semantic format and raw coordinates is large and
 *    consistent — on VGBench, GPT-4 scored 54.9% authoring SVG against 81.0% on
 *    TikZ, the paper's own explanation being that SVG is low-level geometry
 *    while the others carry high-level constructs. SVGenius then showed the
 *    same models collapsing from ~80% to ~33% as a drawing grows past sixteen
 *    paths. Sixteen paths is a button group.
 * 3. **Nothing in the pipeline measures text.** Advance width is a function of
 *    the font file, and a model cannot know it. So the format never asks: it
 *    says "a column with a gap", and the browser does the arithmetic. This is
 *    also why flow layout is the default and absolute positioning is an
 *    explicitly-labelled escape hatch rather than the normal case.
 * 4. **It degrades.** The markup is legible as text in any renderer, which is
 *    Principle IV holding for a picture.
 *
 * The losers, briefly, because someone will re-litigate them: raw **SVG** (a
 * coordinate format, measurably the worst for models to author, and a format
 * every editor rewrites in its own dialect); a **JSON scene graph** (Figma's
 * own MCP server had to ship a sparse fallback after users hit a 351,378-token
 * response, and a tree in JSON diffs as brace churn rather than by line); and a
 * **bespoke DSL** (no model has priors for it, and we would owe the world a
 * layout engine). See `tradeoffs.md`.
 */

/** A layer's identity. Materialized into the file only when it becomes durable. */
export type LayerId = string;

export type LayerKind = 'box' | 'text' | 'image';

export interface LayerBase {
  readonly id: LayerId;
  /**
   * A human-facing label, shown in the layer tree.
   *
   * Prose, not an identifier: "Pay button", not `pay_btn`. It is what an agent
   * reads to know what a layer *is* when the class list only says what it looks
   * like, and it is the difference between a tree a person can navigate and a
   * list of anonymous boxes.
   */
  readonly name: string;
  /** The restricted utility subset. Validated; never silently dropped. */
  readonly classes: readonly string[];
}

export interface BoxLayer extends LayerBase {
  readonly kind: 'box';
  readonly children: readonly Layer[];
}

export interface TextLayer extends LayerBase {
  readonly kind: 'text';
  readonly content: string;
}

export interface ImageLayer extends LayerBase {
  readonly kind: 'image';
  readonly src: string;
  /** Required, and enforced by the linter: it is the only part a model reads. */
  readonly alt: string;
}

export type Layer = BoxLayer | TextLayer | ImageLayer;

export interface Frame {
  readonly id: LayerId;
  readonly name: string;
  /** CSS pixels. A frame is the one place a fixed dimension is honest — it is
   *  the viewport the design is for, not a measurement of its content. */
  readonly width: number;
  readonly height: number | 'auto';
  readonly classes: readonly string[];
  readonly children: readonly Layer[];
}

export interface DesignDocument {
  readonly name: string;
  readonly frames: readonly Frame[];
}

/** Where a problem is, and what to do about it. */
export interface LintFinding {
  readonly layerId: LayerId | null;
  readonly severity: 'error' | 'warning';
  /**
   * Addressed to whoever has to fix it, which is usually a model.
   *
   * "Unknown class `bg-blue-500`. Colours come from the palette: try
   * `bg-accent`." — the name of the problem plus the shape of the fix. A
   * message that only says what is wrong makes the next attempt a guess.
   */
  readonly message: string;
}

export function isContainer(layer: Layer): layer is BoxLayer {
  return layer.kind === 'box';
}

/** Depth-first walk, parents before children. */
export function* walk(design: DesignDocument): Generator<{ layer: Layer | Frame; depth: number }> {
  function* descend(layer: Layer, depth: number): Generator<{ layer: Layer | Frame; depth: number }> {
    yield { layer, depth };
    if (layer.kind === 'box') {
      for (const child of layer.children) yield* descend(child, depth + 1);
    }
  }
  for (const frame of design.frames) {
    yield { layer: frame, depth: 0 };
    for (const child of frame.children) yield* descend(child, 1);
  }
}

/** Find a layer or frame by id. */
export function find(design: DesignDocument, id: LayerId): Layer | Frame | null {
  for (const { layer } of walk(design)) {
    if (layer.id === id) return layer;
  }
  return null;
}
