import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { parseDesign, type DesignDocument } from '@galley/design';
import { schema } from '../editor/schema.js';
import { designToDom } from './toDom.js';

/**
 * Live design references, in the document.
 *
 * A link to a design draws the design underneath the paragraph that mentions
 * it. The reason this is a **widget decoration** rather than a node is the same
 * reason comment highlights are decorations: the document is Markdown, the link
 * is the entire content, and a node would be a thing the schema allows that the
 * serializer has to invent a representation for.
 *
 * A decoration is free of all that. It is not in the document, it is not in the
 * selection, it is not copied, it does not round-trip — because there is nothing
 * to round-trip. Delete the link and the preview goes with it, because the
 * preview never existed as content.
 *
 * The sources arrive from outside: the app fetches each linked design and hands
 * them in through a plugin transaction, so a design changing does not rebuild
 * the document and a document rebuild does not refetch.
 */

export interface DesignSources {
  /** Design markup by document path, for every design this document links to. */
  readonly byPath: ReadonlyMap<string, string>;
  readonly onOpen: (path: string) => void;
}

export const designPreviewKey = new PluginKey<DesignSources>('galley-design-preview');

export const noDesigns: DesignSources = { byPath: new Map(), onOpen: () => undefined };

/** Every path this document links to as a design. */
export function designLinksIn(doc: { descendants(f: (node: never) => void): void }): string[] {
  const paths = new Set<string>();
  (doc as unknown as { descendants(f: (node: { marks: readonly { type: { name: string }; attrs: Record<string, unknown> }[] }) => void): void }).descendants(
    (node) => {
      for (const mark of node.marks) {
        if (mark.type.name === 'link' && mark.attrs.title === 'design') paths.add(String(mark.attrs.href));
      }
    },
  );
  return [...paths];
}

/** Cheap memo, so a design is parsed once per source rather than per redraw. */
const parsed = new Map<string, DesignDocument | null>();
function designFor(source: string): DesignDocument | null {
  if (!parsed.has(source)) {
    if (parsed.size > 64) parsed.clear();
    const result = parseDesign(source);
    parsed.set(source, result.ok ? result.design : null);
  }
  return parsed.get(source) ?? null;
}

export function designPreview(initial: DesignSources): Plugin<DesignSources> {
  return new Plugin<DesignSources>({
    key: designPreviewKey,
    state: {
      init: () => initial,
      apply: (tr, value) => (tr.getMeta(designPreviewKey) as DesignSources | undefined) ?? value,
    },
    props: {
      decorations(state) {
        const sources = designPreviewKey.getState(state);
        if (!sources || sources.byPath.size === 0) return DecorationSet.empty;

        const decorations: Decoration[] = [];
        state.doc.forEach((node, offset) => {
          // One preview per top-level block, after it. Drawing per link would
          // stack three copies under a paragraph that mentions one design three
          // times, which is not what anyone means by a reference.
          const seen = new Set<string>();
          node.descendants((child) => {
            for (const mark of child.marks) {
              if (mark.type === schema.marks.link && mark.attrs.title === 'design') {
                seen.add(String(mark.attrs.href));
              }
            }
          });
          if (seen.size === 0) return;

          for (const path of seen) {
            const source = sources.byPath.get(path);
            if (source === undefined) continue;
            decorations.push(
              Decoration.widget(offset + node.nodeSize, () => card(path, source, sources.onOpen), {
                // Never part of the selection, never draggable, and always
                // *after* the block — a widget that can be selected is a widget
                // a backspace can delete, and there is nothing here to delete.
                side: 1,
                ignoreSelection: true,
                key: `design:${path}:${source.length}`,
              }),
            );
          }
        });
        return DecorationSet.create(state.doc, decorations);
      },
    },
  });
}

function card(path: string, source: string, onOpen: (path: string) => void): HTMLElement {
  const figure = document.createElement('figure');
  figure.className = 'design-preview';
  figure.contentEditable = 'false';

  const design = designFor(source);
  if (!design || design.frames.length === 0) {
    const note = document.createElement('p');
    note.className = 'design-preview-broken';
    note.textContent = 'This design could not be drawn.';
    figure.append(note);
  } else {
    const stage = document.createElement('div');
    stage.className = 'design-preview-stage';
    stage.append(designToDom(design));
    figure.append(stage);
  }

  const caption = document.createElement('figcaption');
  caption.className = 'design-preview-foot';
  const name = document.createElement('span');
  name.textContent = design?.name ?? path;
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'design-preview-open';
  open.textContent = 'Open design';
  open.addEventListener('mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onOpen(path);
  });
  caption.append(name, open);
  figure.append(caption);
  return figure;
}
