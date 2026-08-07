import { type JSX } from 'react';
import { type DesignDocument, type LayerId } from '@galley/design';
import { type Rect } from './camera.js';
import { type Selection } from './selection.js';
/**
 * The canvas.
 *
 * A **bounded** stage, not an infinite one, and that is a decision rather than
 * a shortcut. An infinite canvas is the right shape when a document's contents
 * have arbitrary positions; here they cannot — a design is a flow-layout tree
 * with no coordinates in it at all. An unbounded scroll region would be a
 * promise the format cannot keep, and it would invite the one gesture the whole
 * format exists to prevent: dragging a box to a place.
 *
 * For the same reason there is **no dot grid**. A grid is a coordinate
 * affordance, and there are no coordinates. Drawing one would be a lie about
 * what a drag does.
 *
 * Every gesture is owned here. The overlay takes no pointer events and the
 * layers carry no handlers, so hit-testing exists once — which is what lets a
 * click, a ⌘-click, a marquee and a drag disagree about what they mean without
 * four different pieces of code having to agree about where the pointer is.
 */
export interface StageProps {
    readonly design: DesignDocument;
    readonly mode: string;
    /** A state to show on the canvas without having to hold it. */
    readonly state?: string | null;
    readonly readOnly: boolean;
    readonly anchored?: ReadonlySet<LayerId>;
    readonly selection: Selection;
    onSelection(next: Selection): void;
    /** Escape with nothing left to leave. Usually "close the editor". */
    onEscape(): void;
    /** A drag that landed. The editor turns it into a `move` op. */
    onMove(id: LayerId, parentId: LayerId, index: number): void;
    /** Double-click on text, which means edit the words rather than go inside. */
    onEditText?(id: LayerId): void;
    onDelete(ids: readonly LayerId[]): void;
    /**
     * Where every layer landed, so the inspector can seed a fixed size from what
     * the browser actually drew rather than from a constant.
     */
    onMeasure?(rects: ReadonlyMap<LayerId, Rect>): void;
}
export declare function Stage(props: StageProps): JSX.Element;
//# sourceMappingURL=Stage.d.ts.map