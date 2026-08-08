import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useRef, useState } from 'react';
import { BLOCKS, applyOps, parseDesign, } from '@galley/design';
import { designToDom } from './toDom.js';
import { BLOCK_MIME } from './Stage.js';
/**
 * The things you can add, as pictures of themselves.
 *
 * This pane used to be a layer tree with two buttons over it — `+ Box` and
 * `+ Text`. That is the correct decomposition of the *format* and the wrong
 * decomposition of the *task*: nobody sets out to add a box. The palette offers
 * finished objects instead, which is the one thing Canva does better than every
 * professional tool, and is not the drag-and-drop everyone credits it for.
 *
 * **Each item draws itself by rendering the real block.** A hand-drawn icon
 * would be a second description of the same object, free to drift from it — and
 * the first time a button's fill changed, the palette would be quietly lying.
 * Rendering through the same path the canvas uses makes that impossible: change
 * the block and the picture changes with it.
 *
 * **Two ways to place one, because they answer different questions.** Click
 * means "put it where I am" and needs no aim; drag means "put it *there*" and
 * is the only way to reach a slot that isn't next to the selection. Canva has
 * both. A palette with only drag makes the common case a precision task.
 */
const SHELVES = [
    { group: 'text', title: 'Text' },
    { group: 'action', title: 'Buttons' },
    { group: 'input', title: 'Fields' },
    { group: 'layout', title: 'Layout' },
];
/** The width the previews are composed at, before being scaled down to fit. */
const PREVIEW_WIDTH = 300;
/** Must match `.design-palette-preview-scale`'s transform. */
const PREVIEW_SCALE = 0.3;
/** So a divider — one pixel of block — still reads as a card. */
const PREVIEW_MIN_HEIGHT = 24;
/**
 * The frame the previews are composed in: no padding, no fill.
 *
 * A frame's own background and padding would show around every block as a slab
 * of empty canvas, which is what a first pass at this looked like. The card is
 * a picture of the *block*, not of a screen containing it.
 */
const EMPTY = [
    '<design name="Preview">',
    `  <frame name="Preview" width="${PREVIEW_WIDTH}" class="flex flex-col">`,
    '  </frame>',
    '</design>',
].join('\n');
/**
 * Every block, rendered once, as a design of its own.
 *
 * Built at module scope rather than per render: the catalog is a constant, so
 * the fourteen parses and inserts are work that can only ever produce the same
 * fourteen answers.
 */
const PREVIEWS = (() => {
    const built = new Map();
    const parsed = parseDesign(EMPTY);
    if (!parsed.ok)
        return built;
    for (const block of BLOCKS) {
        const frame = parsed.design.frames[0];
        if (!frame)
            continue;
        const grown = applyOps(parsed.design, [
            { op: 'insert', parent: frame.id, index: 0, layer: block.layer },
        ]);
        if (grown.ok)
            built.set(block.id, grown.design);
    }
    return built;
})();
/**
 * One preview, as plain DOM inside a React-owned div.
 *
 * `designToDom` rather than `DesignView` for the same reason the prose preview
 * uses it: this subtree is static, it has no interactivity to wire, and the
 * renderer is already written and tested. It is mounted through a ref rather
 * than rendered as JSX because it produces DOM, not elements — and it is
 * rebuilt only when the block changes, which is never.
 */
function BlockPreview({ block, mode }) {
    const host = useRef(null);
    const design = PREVIEWS.get(block.id);
    /**
     * How tall the card is, derived from how tall the block turned out.
     *
     * A fixed height cannot work for a catalog whose entries range from a divider
     * to a two-field row: too small and the card crops the block, too large and
     * every short block sits on a slab of empty frame. The scaled subtree is
     * `position: absolute`, so it contributes no height of its own — the number
     * has to come from measuring it and be put back as the card's height.
     */
    const [height, setHeight] = useState(PREVIEW_MIN_HEIGHT);
    useEffect(() => {
        const node = host.current;
        if (!node || !design)
            return;
        node.replaceChildren(designToDom(design, mode));
        // After layout, not during: the block's height is whatever the browser
        // decided, which is the entire reason this format never measures text
        // itself. The rect is already the *scaled* box — `getBoundingClientRect`
        // reports the transformed geometry — so it is the card height directly.
        const drawn = node.getBoundingClientRect().height;
        setHeight(Math.max(PREVIEW_MIN_HEIGHT, Math.round(drawn)));
    }, [design, mode]);
    return (_jsx("span", { className: "design-palette-preview", style: { height }, "aria-hidden": "true", children: _jsx("span", { className: "design-palette-preview-scale", 
            // Width and scale together, here rather than in the stylesheet: the
            // measurement above divides by this exact number, and a scale that
            // lived in CSS could be changed without the measurement noticing.
            style: { width: PREVIEW_WIDTH, transform: `scale(${PREVIEW_SCALE})` }, ref: host }) }));
}
export function Palette({ mode, disabled, onAdd, }) {
    const shelves = useMemo(() => SHELVES.map((shelf) => ({
        ...shelf,
        blocks: BLOCKS.filter((block) => block.group === shelf.group),
    })).filter((shelf) => shelf.blocks.length > 0), []);
    const onDragStart = (event, block) => {
        event.dataTransfer.setData(BLOCK_MIME, block.id);
        // `copy`, not `move`: the palette entry stays where it is. The cursor says
        // so, which is the only feedback anyone gets before letting go.
        event.dataTransfer.effectAllowed = 'copy';
    };
    return (_jsx("div", { className: "design-palette", "data-testid": "design-palette", children: shelves.map((shelf) => (_jsxs("section", { className: "design-palette-shelf", children: [_jsx("h3", { className: "design-palette-heading", children: shelf.title }), _jsx("div", { className: "design-palette-items", children: shelf.blocks.map((block) => (_jsxs("button", { type: "button", className: "design-palette-item", "data-testid": `block-${block.id}`, disabled: disabled, draggable: !disabled, onDragStart: (event) => onDragStart(event, block), onClick: () => onAdd(block), title: block.hint, children: [_jsx(BlockPreview, { block: block, mode: mode }), _jsx("span", { className: "design-palette-name", children: block.label })] }, block.id))) })] }, shelf.group))) }));
}
//# sourceMappingURL=Palette.js.map