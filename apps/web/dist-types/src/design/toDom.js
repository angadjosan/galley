import { designCss, hasStates, resolveClasses } from '@galley/design';
/**
 * A design as plain DOM.
 *
 * The canvas renders designs with React; this does not, and the difference is
 * load-bearing rather than stylistic. This output goes inside a ProseMirror
 * *widget decoration*, and a React root mounted there would put the subtree's
 * lifetime under React's reconciler while its position is under ProseMirror's.
 * The two disagree during a document rebuild, which is exactly when a preview
 * must not flicker or leak a root.
 *
 * It is also why nothing here is interactive. A preview is a picture of a
 * design that lives somewhere else; the place to change it is that document.
 */
let previews = 0;
export function designToDom(design, mode) {
    const wrapper = document.createElement('div');
    wrapper.className = 'design-preview-frames';
    // A preview is interactive in exactly one way: the states resolve. Hovering a
    // button in a document and seeing it respond is the cheapest possible proof
    // that the design describes a real thing.
    if (hasStates(design)) {
        const instance = `p${(previews += 1)}`;
        wrapper.dataset.design = instance;
        const style = document.createElement('style');
        style.textContent = designCss(design, instance);
        wrapper.append(style);
    }
    for (const frame of design.frames) {
        const surface = document.createElement('div');
        surface.className = 'design-surface';
        if (mode)
            surface.dataset.mode = mode;
        surface.style.width = `${frame.width}px`;
        if (frame.height !== 'auto')
            surface.style.height = `${frame.height}px`;
        apply(surface, frame.classes);
        for (const child of frame.children)
            surface.append(layerToDom(child));
        wrapper.append(surface);
    }
    return wrapper;
}
function layerToDom(layer) {
    if (layer.kind === 'text') {
        const span = document.createElement('span');
        // `textContent`, never `innerHTML`. A design's text is content, and the
        // markup it came from was already parsed — re-interpreting it here would be
        // a second parse of an author's words, which is how injection happens.
        span.textContent = layer.content;
        apply(span, layer.classes);
        return span;
    }
    if (layer.kind === 'image') {
        const img = document.createElement('img');
        img.src = layer.src;
        img.alt = layer.alt;
        apply(img, layer.classes);
        return img;
    }
    const box = document.createElement('div');
    apply(box, layer.classes);
    for (const child of layer.children)
        box.append(layerToDom(child));
    return box;
}
function apply(element, classes) {
    const { css } = resolveClasses(classes);
    for (const [property, value] of Object.entries(css))
        element.style.setProperty(property, value);
}
//# sourceMappingURL=toDom.js.map