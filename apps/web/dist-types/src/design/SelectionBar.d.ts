import type { JSX } from 'react';
import { type Frame, type Layer } from '@galley/design';
import { type Camera, type Rect } from './camera.js';
/**
 * The controls that belong to the thing you are pointing at.
 *
 * A design tool where changing a gap means crossing the screen to a panel and
 * finding the right row is a form with a picture attached. Arrangement is
 * *about* the shape on the canvas — direction, gap, padding, alignment are all
 * answers to "how do these sit together", and the sitting-together is right
 * there. So the controls are too, floating over the selection.
 *
 * What stays in the right rail is **paint**: colour, type, corners. Those are
 * choices from a palette rather than manipulations of a shape, a palette is a
 * list, and a list wants a column with room for names.
 *
 * Positioned in viewport space and drawn at a constant screen size, like
 * everything else on the overlay — a toolbar that shrank at 50% zoom would be
 * unusable exactly when you most need to see what you are doing.
 */
export interface SelectionBarProps {
    readonly camera: Camera;
    readonly rects: ReadonlyMap<string, Rect>;
    readonly layers: readonly (Layer | Frame)[];
    readonly readOnly: boolean;
    /** True while a gesture is in flight, when the bar would be in the way. */
    readonly hidden: boolean;
    onEdit(change: (layer: Layer) => Layer): void;
    onDelete(): void;
    onDuplicate(): void;
}
export declare function SelectionBar(props: SelectionBarProps): JSX.Element | null;
//# sourceMappingURL=SelectionBar.d.ts.map