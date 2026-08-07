import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { find, type DesignDocument, type LayerId } from '@galley/design';
import {
  IDENTITY,
  MAX_ZOOM,
  MIN_ZOOM,
  fit,
  toViewport,
  unionOf,
  useLayerRects,
  zoomAbout,
  type Camera,
  type Rect,
} from './camera.js';
import {
  DIRECTION_WINDOW,
  DRAG_ACTIVATE,
  EDGE_INSET,
  axisOf,
  dropLine,
  moveIndex,
  resolveDrop,
  sameTarget,
  slotOf,
  type DropTarget,
} from './drop.js';
import { Overlay } from './Overlay.js';
import { childrenOf } from './tree.js';
import { DesignView } from './render.js';
import {
  clickSelect,
  enterSelection,
  exitSelection,
  focusFor,
  marqueeSelect,
  resolveClick,
  type Selection,
} from './selection.js';

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

/** What the pointer is in the middle of. Exactly one at a time, by construction. */
type Gesture =
  | { readonly kind: 'none' }
  | { readonly kind: 'pan'; readonly from: { x: number; y: number }; readonly camera: Camera }
  | { readonly kind: 'press'; readonly id: LayerId; readonly from: { x: number; y: number } }
  | { readonly kind: 'drag'; readonly id: LayerId }
  | { readonly kind: 'marquee'; readonly from: { x: number; y: number }; readonly to: { x: number; y: number } };

export function Stage(props: StageProps): JSX.Element {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [camera, setCamera] = useState<Camera>(IDENTITY);
  const [gesture, setGesture] = useState<Gesture>({ kind: 'none' });
  const [hovered, setHovered] = useState<LayerId | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);
  const [spacePan, setSpacePan] = useState(false);

  const rects = useLayerRects(content, camera, props.design);

  const onMeasure = props.onMeasure;
  useEffect(() => {
    onMeasure?.(rects);
  }, [onMeasure, rects]);

  /**
   * Which way the pointer is travelling, per axis, measured over a window.
   *
   * A frame-to-frame delta is noise: a resting hand changes sign most frames,
   * and the midpoint bias that depends on it then flickers. The window is
   * Puck's `INTERVAL_SENSITIVITY`, and it is the single highest-value line in a
   * drag implementation.
   */
  const travel = useRef({ x: { dir: 1 as 1 | -1, at: 0 }, y: { dir: 1 as 1 | -1, at: 0 } });

  /**
   * The current props and gesture, readable from a window listener.
   *
   * The keyboard effect must not re-subscribe: `props` is a fresh object on
   * every parent render, so depending on it tore both window listeners down and
   * re-added them constantly — and a keydown that arrives in that gap is a
   * keystroke that does nothing. Reading through a ref makes the subscription
   * happen once and still see the latest state.
   */
  const latest = useRef(props);
  latest.current = props;
  const gestureRef = useRef<Gesture>(gesture);
  gestureRef.current = gesture;

  // ---------------------------------------------------------------------
  // Camera
  // ---------------------------------------------------------------------

  const fitAll = useCallback(() => {
    const node = viewport.current;
    const bounds = unionOf(props.design.frames.map((frame) => rects.get(frame.id)).filter((r): r is Rect => !!r));
    if (!node || !bounds) return;
    setCamera(fit(bounds, { width: node.clientWidth, height: node.clientHeight }));
  }, [props.design, rects]);

  // Fit once, when there is something to fit to. Re-fitting on every change
  // would move the canvas under someone who has deliberately zoomed in.
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || rects.size === 0) return;
    fitted.current = true;
    fitAll();
  }, [fitAll, rects.size]);

  /**
   * A selection made somewhere else is brought on screen.
   *
   * Panned, never zoomed: the zoom is the reader's and moving it because they
   * clicked a row in a list would be the canvas taking a decision that was not
   * theirs. Only runs when the layer is actually outside the viewport, so
   * clicking around what you can already see never moves anything.
   */
  useEffect(() => {
    const node = viewport.current;
    const bounds = unionOf(props.selection.ids.map((id) => rects.get(id)).filter((r): r is Rect => !!r));
    if (!node || !bounds || gestureRef.current.kind !== 'none') return;
    setCamera((current) => {
      const at = toViewport(current, bounds);
      const size = { width: bounds.width * current.zoom, height: bounds.height * current.zoom };
      const margin = 24;
      const slide = (start: number, extent: number, viewportExtent: number): number => {
        if (start >= margin && start + extent <= viewportExtent - margin) return 0;
        if (extent > viewportExtent - margin * 2) return start - margin;
        return start < margin ? start - margin : start + extent - (viewportExtent - margin);
      };
      const dx = slide(at.x, size.width, node.clientWidth);
      const dy = slide(at.y, size.height, node.clientHeight);
      if (dx === 0 && dy === 0) return current;
      return { ...current, x: current.x + dx / current.zoom, y: current.y + dy / current.zoom };
    });
    // Deliberately not keyed on `rects`: they change on every measurement, and
    // re-running this then fights a pan the reader is in the middle of.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.selection.ids]);

  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const onWheel = (event: WheelEvent): void => {
      // Non-passive, because both branches take the gesture away from the page:
      // without `preventDefault` a trackpad pinch zooms the browser and a
      // two-finger scroll scrolls the document behind the editor.
      event.preventDefault();
      const box = node.getBoundingClientRect();
      const at = { x: event.clientX - box.left, y: event.clientY - box.top };
      // ⌘ or Ctrl means zoom. A trackpad pinch arrives as a wheel event with
      // `ctrlKey` set — the same branch, which is why pinch works for free.
      if (event.ctrlKey || event.metaKey) {
        setCamera((current) => zoomAbout(current, at, current.zoom * Math.exp(-event.deltaY / 200)));
        return;
      }
      setCamera((current) => {
        // Shift turns a vertical wheel into a horizontal pan, which is what a
        // mouse with one wheel needs and what every canvas binds it to. A
        // trackpad already sends `deltaX`, so both are added rather than
        // chosen between.
        const dx = event.deltaX + (event.shiftKey ? event.deltaY : 0);
        const dy = event.shiftKey ? 0 : event.deltaY;
        return { ...current, x: current.x + dx / current.zoom, y: current.y + dy / current.zoom };
      });
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, []);

  /**
   * Bring the selection into view.
   *
   * The layer tree is the escape hatch for the focus model — "cannot click it?
   * use the tree" — and it was useless at any zoom above fit, because picking a
   * row would leave the inspector editing something a thousand pixels off
   * screen with nothing on screen to say so.
   */
  const zoomToSelection = useCallback(() => {
    const node = viewport.current;
    const bounds = unionOf(props.selection.ids.map((id) => rects.get(id)).filter((r): r is Rect => !!r));
    if (!node || !bounds) return;
    setCamera(fit(bounds, { width: node.clientWidth, height: node.clientHeight }, 120));
  }, [props.selection.ids, rects]);

  // These change identity whenever the rects do, so the keyboard effect reaches
  // them through refs rather than re-subscribing for them.
  const fitRef = useRef(fitAll);
  fitRef.current = fitAll;
  const zoomToRef = useRef(zoomToSelection);
  zoomToRef.current = zoomToSelection;

  const zoomBy = useCallback((factor: number) => {
    const node = viewport.current;
    if (!node) return;
    const centre = { x: node.clientWidth / 2, y: node.clientHeight / 2 };
    setCamera((current) => zoomAbout(current, centre, current.zoom * factor));
  }, []);

  // ---------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------

  useEffect(() => {
    const onDown = (event: KeyboardEvent): void => {
      if (event.key === ' ' && !isTyping(event.target) && !isControl(event.target)) {
        // Space-drag pans, the one gesture every canvas tool shares. Held
        // rather than toggled, so it cannot be left on.
        //
        // Not when a control has focus. `preventDefault` on a button's Space
        // suppresses the click the browser would synthesize, so stealing it
        // unconditionally makes every button in the editor keyboard-dead —
        // which is the exact defect this codebase has now found three times.
        event.preventDefault();
        setSpacePan(true);
        return;
      }
      if (isTyping(event.target)) return;
      if (event.key === 'Escape') {
        // A drag in flight is what Escape is *for*. Cancelling it here rather
        // than popping the selection is what makes a drag safe to start.
        if (gestureRef.current.kind === 'drag' || gestureRef.current.kind === 'marquee') {
          setGesture({ kind: 'none' });
          setTarget(null);
          return;
        }
        const next = exitSelection(latest.current.design, latest.current.selection);
        if (next) latest.current.onSelection(next);
        else latest.current.onEscape();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        latest.current.onSelection(enterSelection(latest.current.design, latest.current.selection));
        return;
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        // The whole selection, not just a lone layer. A marquee that selects
        // three cards and then refuses to delete them is the canvas asserting
        // something the rest of the editor denies.
        const ids = latest.current.selection.ids.filter((id) => !isFrameId(latest.current.design, id));
        if (ids.length > 0 && !latest.current.readOnly) {
          event.preventDefault();
          latest.current.onDelete(ids);
        }
        return;
      }
      if (ARROWS.has(event.key)) {
        /**
         * Arrows **reorder**. They do not nudge.
         *
         * Nudging is a coordinate gesture and this format has no coordinates,
         * so an arrow key that moved a layer by a pixel would have nowhere to
         * write the pixel. Reordering is the same intent — "put this before
         * that" — expressed in what the file can actually hold, and it is the
         * only keyboard equivalent of the drag that exists.
         */
        const id = latest.current.selection.ids.length === 1 ? latest.current.selection.ids[0]! : null;
        const from = id ? slotOf(latest.current.design, id) : null;
        if (!id || !from || latest.current.readOnly) return;
        const parent = find(latest.current.design, from.parentId);
        if (!parent) return;
        const along = axisOf(parent) === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
        // An arrow across the flow does nothing rather than something
        // arbitrary: in a row, up and down have no order to express.
        if (!along.includes(event.key)) return;
        event.preventDefault();
        const step = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1;
        const index = from.index + step;
        if (index < 0 || index >= childCount(latest.current.design, from.parentId)) return;
        latest.current.onMove(id, from.parentId, index);
        return;
      }
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === '0') {
        // About the viewport centre, not the content origin. Setting the zoom
        // directly leaves the camera where it was, which at 400% throws the
        // design off screen — and with no scrollbars and no minimap, nothing
        // on screen tells you where it went.
        event.preventDefault();
        setCamera((current) => zoomAbout(current, centreOf(viewport.current), 1));
        return;
      }
      if (event.key === '9' || event.key === '1') {
        event.preventDefault();
        fitRef.current();
        return;
      }
      if (event.key === '2') {
        event.preventDefault();
        zoomToRef.current();
        return;
      }
      if (event.key === '=' || event.key === '+' || event.key === '-') {
        // Bound, and prevented. Unhandled these fall through to the browser's
        // own zoom, which scales the entire application — every canvas tool
        // takes these keys for exactly that reason.
        event.preventDefault();
        setCamera((current) =>
          zoomAbout(current, centreOf(viewport.current), current.zoom * (event.key === '-' ? 1 / 1.2 : 1.2)),
        );
      }
    };
    const onUp = (event: KeyboardEvent): void => {
      if (event.key === ' ') setSpacePan(false);
    };
    // The keyup for a held Space is delivered to whatever window has focus, so
    // ⌘-Tab away mid-pan and it never arrives — leaving the canvas permanently
    // in pan mode, where clicking, selecting and dragging are all dead and the
    // only cue is the cursor.
    const onBlur = (): void => setSpacePan(false);
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // ---------------------------------------------------------------------
  // Pointer
  // ---------------------------------------------------------------------

  /** Pointer in canvas space — the coordinates everything else here speaks. */
  const pointAt = useCallback(
    (event: { clientX: number; clientY: number }): { x: number; y: number } => {
      const node = content.current;
      if (!node) return { x: 0, y: 0 };
      const box = node.getBoundingClientRect();
      return { x: (event.clientX - box.left) / camera.zoom, y: (event.clientY - box.top) / camera.zoom };
    },
    [camera.zoom],
  );

  /**
   * The layer under the pointer.
   *
   * From the point, not from `event.target`. Capturing the pointer — which a
   * drag has to do, or the gesture dies the moment it leaves the element —
   * makes the browser retarget every subsequent pointer, click and double-click
   * event at the capturing element. So `event.target` is the stage itself for
   * the rest of the gesture, and reading it silently turns every double-click
   * into a no-op.
   *
   * The overlay takes no pointer events, so it is never what comes back.
   */
  const layerUnder = (event: { clientX: number; clientY: number }): LayerId | null => {
    const at = document.elementFromPoint(event.clientX, event.clientY);
    const element = (at as HTMLElement | null)?.closest<HTMLElement>('[data-layer-id]');
    return element?.dataset.layerId ?? null;
  };

  const onPointerDown = (event: ReactPointerEvent): void => {
    // The zoom controls sit inside the stage so they float over the design.
    // Capturing the pointer for them would mean the button never sees its own
    // click — the control would be visible, hoverable and completely dead.
    if ((event.target as HTMLElement | null)?.closest('.design-zoom')) return;
    // One gesture at a time. A second finger — the stage sets `touch-action:
    // none`, so it gets one — would otherwise overwrite the gesture mid-drag
    // and capture a different pointer, and the first finger's release would
    // then complete the second finger's gesture.
    if (gesture.kind !== 'none') return;

    travel.current = { x: { dir: 1, at: event.clientX }, y: { dir: 1, at: event.clientY } };
    if (event.button === 1 || spacePan) {
      event.currentTarget.setPointerCapture(event.pointerId);
      setGesture({ kind: 'pan', from: { x: event.clientX, y: event.clientY }, camera });
      return;
    }
    if (event.button === 2) {
      // Selects what is under it. Right-clicking a layer and having the
      // selection stay somewhere else is how a context menu ends up acting on
      // the wrong thing — so the selection moves even though there is no menu
      // yet.
      const hit = layerUnder(event);
      const claimed = hit ? resolveClick(props.design, hit, props.selection.focus) : null;
      if (claimed) props.onSelection({ focus: focusFor(props.design, claimed), ids: [claimed] });
      return;
    }
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);

    // Nothing under the pointer, or the container we are already inside —
    // its background is not a thing to select, it is the empty space of this
    // level. Both start a marquee, which is what makes the children of a
    // full-bleed frame reachable at all.
    const hit = layerUnder(event);
    const claimed = hit ? resolveClick(props.design, hit, props.selection.focus) : null;
    if (!claimed) {
      const from = pointAt(event);
      setGesture({ kind: 'marquee', from, to: from });
      return;
    }

    const next = clickSelect(props.design, props.selection, hit!, {
      deep: event.metaKey || event.ctrlKey,
      extend: event.shiftKey,
    });
    props.onSelection(next);

    // A press on something selectable *might* be a drag. Which it is depends on
    // whether the pointer moves — decided on move rather than here, so a click
    // that happens to wobble two pixels is still a click.
    const grabbed = next.ids.length === 1 ? next.ids[0]! : null;
    if (grabbed && !props.readOnly && !isFrameId(props.design, grabbed)) {
      setGesture({ kind: 'press', id: grabbed, from: { x: event.clientX, y: event.clientY } });
    }
  };

  const onPointerMove = (event: ReactPointerEvent): void => {
    if (gesture.kind === 'pan') {
      const dx = (event.clientX - gesture.from.x) / gesture.camera.zoom;
      const dy = (event.clientY - gesture.from.y) / gesture.camera.zoom;
      setCamera({ ...gesture.camera, x: gesture.camera.x - dx, y: gesture.camera.y - dy });
      return;
    }
    if (gesture.kind === 'marquee') {
      setGesture({ ...gesture, to: pointAt(event) });
      return;
    }

    updateTravel(travel.current, event);

    if (gesture.kind === 'press') {
      const moved = Math.hypot(event.clientX - gesture.from.x, event.clientY - gesture.from.y);
      if (moved < DRAG_ACTIVATE) return;
      setGesture({ kind: 'drag', id: gesture.id });
      return;
    }
    if (gesture.kind === 'drag') {
      setTarget((previous) => {
        const next = resolveFor(props.design, rects, pointAt(event), gesture.id, camera.zoom, travel.current);
        // Only a *changed* slot causes a render. Recomputing is cheap;
        // redrawing an indicator sixty times a second in the same place is the
        // flicker every hand-rolled drag ships with.
        return sameTarget(previous, next) ? previous : next;
      });
      return;
    }

    const hit = layerUnder(event);
    setHovered(hit ? resolveClick(props.design, hit, props.selection.focus) : null);
  };

  /**
   * The browser took the gesture away — palm rejection, an OS gesture, a lost
   * capture. Discarded, never committed: `pointercancel` means the drag did not
   * finish, and writing a move op plus a history entry for a gesture the user
   * did not complete is the worst possible reading of it.
   */
  const onPointerCancel = (event: ReactPointerEvent): void => {
    setGesture({ kind: 'none' });
    setTarget(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onPointerUp = (event: ReactPointerEvent): void => {
    // Only the button that started the gesture may end it. Otherwise a
    // right-click during a left-button drag commits the drop.
    if (event.button !== 0 && event.button !== 1) return;
    if (gesture.kind === 'marquee') {
      const box = boxOf(gesture.from, gesture.to);
      // Screen pixels, not canvas units: at 10% zoom a one-pixel wobble is ten
      // canvas units and would count as a deliberate brush, and at 400% a real
      // eight-pixel drag is two units and would count as a click that clears
      // the selection.
      const grew = Math.max(box.width, box.height) * camera.zoom > 2;
      if (grew) {
        props.onSelection(marqueeSelect(props.design, props.selection.focus, rects, box));
      } else {
        props.onSelection({ focus: props.selection.focus, ids: [] });
      }
    } else if (gesture.kind === 'drag' && target) {
      const from = slotOf(props.design, gesture.id);
      if (from) {
        const index = moveIndex(from, target);
        // A move to where it already is is not a move. Committing it would
        // rewrite the file and land an entry in the history for nothing.
        if (from.parentId !== target.parentId || from.index !== index) {
          props.onMove(gesture.id, target.parentId, index);
        }
      }
    }
    setGesture({ kind: 'none' });
    setTarget(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onDoubleClick = (event: ReactMouseEvent): void => {
    const hit = layerUnder(event);
    if (!hit) return;
    // Resolved through the focus model first, so both halves of the same
    // gesture agree about which layer was meant: without it, "edit the text"
    // would open the words of a layer three levels below the one "go inside"
    // would have entered.
    const target = resolveClick(props.design, hit, props.selection.focus) ?? hit;
    const node = find(props.design, target);
    if (node && 'kind' in node && node.kind === 'text') {
      // Double-clicking words means edit the words. There is nothing to be
      // inside, so without this the gesture does nothing at all.
      props.onSelection({ focus: props.selection.focus, ids: [target] });
      props.onEditText?.(target);
      return;
    }
    props.onSelection(enterSelection(props.design, props.selection, hit));
  };

  const line = useMemo(
    () => (target ? dropLine(props.design, rects, target) : null),
    [props.design, rects, target],
  );
  const marquee = gesture.kind === 'marquee' ? boxOf(gesture.from, gesture.to) : null;

  return (
    <div
      className={`design-stage ${spacePan ? 'is-panning' : ''} ${gesture.kind === 'drag' ? 'is-dragging' : ''}`}
      ref={viewport}
      data-testid="design-stage"
      // The selection, on the element, so a test can assert on what is
      // selected rather than on what a stroke happens to look like.
      data-gesture={gesture.kind}
      data-focus={props.selection.focus ?? ''}
      data-selected={props.selection.ids.join(' ')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={() => setHovered(null)}
      onDoubleClick={onDoubleClick}
      // The browser's own menu over a design canvas offers Reload and Save As,
      // which is never what the hand was reaching for.
      onContextMenu={(event) => event.preventDefault()}
    >
      <div
        className="design-stage-content"
        ref={content}
        style={{
          transform: `scale(${camera.zoom}) translate(${-camera.x}px, ${-camera.y}px)`,
          transformOrigin: '0 0',
        }}
      >
        <DesignView
          design={props.design}
          options={{
            mode: props.mode,
            anchored: props.anchored,
            ghostId: gesture.kind === 'drag' ? gesture.id : null,
          }}
        />
      </div>

      <Overlay
        camera={camera}
        rects={rects}
        selected={props.selection.ids}
        hovered={gesture.kind === 'drag' ? null : hovered}
        focus={props.selection.focus}
        anchored={props.anchored}
        dropLine={line}
        marquee={marquee}
      />

      <div className="design-zoom" role="group" aria-label="Zoom">
        <button type="button" onClick={() => zoomBy(1 / 1.2)} disabled={camera.zoom <= MIN_ZOOM} aria-label="Zoom out">
          −
        </button>
        <button type="button" onClick={fitAll} title="Fit the design in the window">
          {Math.round(camera.zoom * 100)}%
        </button>
        <button type="button" onClick={() => zoomBy(1.2)} disabled={camera.zoom >= MAX_ZOOM} aria-label="Zoom in">
          +
        </button>
      </div>
    </div>
  );
}

/**
 * The slot, resolved with the direction that matters for *this* parent.
 *
 * Two passes, because which axis the direction should be read from is a
 * property of the parent the pointer landed in, and that is not known until
 * after the first resolve. The second pass is a few array walks over a tree
 * with tens of nodes.
 */
function resolveFor(
  design: DesignDocument,
  rects: ReadonlyMap<LayerId, Rect>,
  pointer: { x: number; y: number },
  draggedId: LayerId,
  zoom: number,
  travel: { x: { dir: 1 | -1 }; y: { dir: 1 | -1 } },
): DropTarget | null {
  const input = { pointer, rects, design, draggedId, inset: EDGE_INSET / zoom };
  const first = resolveDrop(input, travel.y.dir);
  if (!first) return null;
  const parent = find(design, first.parentId);
  if (!parent || axisOf(parent) !== 'x') return first;
  return resolveDrop(input, travel.x.dir);
}

/** Direction, believed only once the pointer has travelled far enough to mean it. */
function updateTravel(
  travel: { x: { dir: 1 | -1; at: number }; y: { dir: 1 | -1; at: number } },
  event: { clientX: number; clientY: number },
): void {
  for (const [axis, value] of [
    ['x', event.clientX],
    ['y', event.clientY],
  ] as const) {
    const state = travel[axis];
    const delta = value - state.at;
    if (Math.abs(delta) < DIRECTION_WINDOW) continue;
    state.dir = delta > 0 ? 1 : -1;
    state.at = value;
  }
}

/** The middle of the viewport, in viewport coordinates. */
function centreOf(node: HTMLElement | null): { x: number; y: number } {
  return node ? { x: node.clientWidth / 2, y: node.clientHeight / 2 } : { x: 0, y: 0 };
}

function boxOf(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

const ARROWS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

function childCount(design: DesignDocument, parentId: LayerId): number {
  const parent = find(design, parentId);
  return parent ? childrenOf(parent).length : 0;
}

function isFrameId(design: DesignDocument, id: LayerId): boolean {
  return design.frames.some((frame) => frame.id === id);
}

/** A keystroke meant for a focused control is not one meant for the canvas. */
function isControl(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return !!element?.closest?.('button, a, [role="button"], [tabindex]:not([tabindex="-1"])');
}

/** A keystroke meant for a field is not a keystroke meant for the canvas. */
function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || !('tagName' in element)) return false;
  return (
    element.tagName === 'INPUT' ||
    element.tagName === 'TEXTAREA' ||
    element.tagName === 'SELECT' ||
    element.isContentEditable === true
  );
}
