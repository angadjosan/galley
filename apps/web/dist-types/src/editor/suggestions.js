import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
export const suggestionKey = new PluginKey('galley-suggestions');
export function suggestionReview(initial, handlers) {
    return new Plugin({
        key: suggestionKey,
        state: {
            init: () => initial,
            apply: (tr, value) => tr.getMeta(suggestionKey) ?? value,
        },
        props: {
            decorations(state) {
                const pending = suggestionKey.getState(state);
                if (!pending || pending.length === 0)
                    return DecorationSet.empty;
                const decorations = [];
                state.doc.descendants((node, offset) => {
                    const blockId = node.attrs.blockId;
                    if (!blockId)
                        return true;
                    const here = pending.filter((suggestion) => suggestion.blockId === blockId);
                    if (here.length === 0)
                        return true;
                    decorations.push(Decoration.node(offset, offset + node.nodeSize, { class: 'block-suggested' }));
                    for (const suggestion of here) {
                        const current = node.textContent;
                        decorations.push(Decoration.widget(offset + node.nodeSize, () => renderCard(suggestion, current, handlers), {
                            side: 1,
                            // The paragraph's current text is part of what this card
                            // renders — it is the struck-through half of the diff. Leave it
                            // out of the key and ProseMirror reuses the existing DOM when
                            // the paragraph is edited, so the reviewer accepts against a
                            // diff that no longer describes the document.
                            key: `suggestion-${suggestion.id}-${suggestion.state}-${hash(current)}`,
                            ignoreSelection: true,
                        }));
                    }
                    return true;
                });
                return DecorationSet.create(state.doc, decorations);
            },
        },
    });
}
/** Cheap content fingerprint, only ever compared for equality. */
function hash(text) {
    let value = 0;
    for (let i = 0; i < text.length; i++)
        value = (Math.imul(value, 31) + text.charCodeAt(i)) | 0;
    return `${text.length}:${value}`;
}
function renderCard(suggestion, currentText, handlers) {
    const card = document.createElement('aside');
    card.className = `suggestion suggestion-${suggestion.state}`;
    card.setAttribute('data-testid', 'suggestion-card');
    card.setAttribute('data-suggestion-id', suggestion.id);
    card.contentEditable = 'false';
    const head = document.createElement('header');
    head.className = 'suggestion-head';
    const avatar = document.createElement('span');
    avatar.className = suggestion.byAgent ? 'avatar avatar-agent' : 'avatar';
    avatar.textContent = suggestion.byAgent ? '' : suggestion.authorName.slice(0, 1).toUpperCase();
    avatar.setAttribute('aria-hidden', 'true');
    head.append(avatar);
    const who = document.createElement('div');
    who.className = 'suggestion-who';
    const name = document.createElement('span');
    name.className = 'who-name';
    name.textContent = suggestion.authorName;
    who.append(name);
    const sub = document.createElement('span');
    sub.className = 'who-sub';
    // The single most reassuring string in the product: it turns an
    // unaccountable machine into a named person's tool.
    sub.textContent = suggestion.byAgent
        ? suggestion.sponsorName
            ? `set up by ${suggestion.sponsorName} · suggested a change`
            : 'suggested a change'
        : 'suggested a change';
    who.append(sub);
    head.append(who);
    card.append(head);
    if (suggestion.rationale) {
        const why = document.createElement('div');
        why.className = 'suggestion-why';
        why.textContent = suggestion.rationale;
        card.append(why);
    }
    const diff = document.createElement('div');
    diff.className = 'suggestion-diff';
    for (const part of diffWords(currentText, suggestion.proposed)) {
        if (part.kind === 'same') {
            diff.append(document.createTextNode(part.text));
            continue;
        }
        const span = document.createElement('span');
        span.className = part.kind === 'add' ? 'diff-add' : 'diff-remove';
        span.textContent = part.text;
        diff.append(span);
    }
    card.append(diff);
    const foot = document.createElement('footer');
    foot.className = 'suggestion-foot';
    if (suggestion.state === 'stale') {
        const note = document.createElement('div');
        note.className = 'suggestion-stale';
        // A disabled primary button invites a click and teaches nothing, so the
        // action is absent rather than greyed out.
        note.textContent = `This paragraph changed after ${suggestion.authorName} wrote this, so it can't be applied.`;
        foot.append(note);
        foot.append(button('Dismiss', 'ghost', () => handlers.current.reject(suggestion.id)));
    }
    else {
        const reassure = document.createElement('div');
        reassure.className = 'suggestion-safe';
        reassure.textContent = 'Nothing changes until you accept it.';
        foot.append(reassure);
        const actions = document.createElement('div');
        actions.className = 'suggestion-actions';
        actions.append(button('Use this', 'primary', () => handlers.current.accept(suggestion.id), suggestion.id), button('Dismiss', 'ghost', () => handlers.current.reject(suggestion.id)), button('Edit instead', 'ghost', () => handlers.current.acceptAndEdit(suggestion.id)));
        foot.append(actions);
    }
    card.append(foot);
    return card;
}
function button(label, kind, onClick, acceptId) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = kind;
    element.textContent = label;
    if (acceptId)
        element.setAttribute('data-testid', `accept-${acceptId}`);
    // Without this the editor selection collapses before the handler runs.
    element.addEventListener('mousedown', (event) => event.preventDefault());
    element.addEventListener('click', (event) => {
        event.preventDefault();
        onClick();
    });
    return element;
}
/**
 * A word-level diff, so a reviewer sees what changed rather than two paragraphs.
 *
 * Longest common subsequence over words-with-their-trailing-space. Documents
 * are paragraph-sized here, so the quadratic table is cheap and the result is
 * minimal, which a heuristic differ cannot promise.
 */
export function diffWords(before, after) {
    const a = tokenize(before);
    const b = tokenize(after);
    const lengths = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            lengths[i][j] =
                a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
        }
    }
    const parts = [];
    const push = (kind, text) => {
        const last = parts[parts.length - 1];
        if (last && last.kind === kind)
            parts[parts.length - 1] = { kind, text: last.text + text };
        else
            parts.push({ kind, text });
    };
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            push('same', a[i]);
            i++;
            j++;
        }
        else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
            push('remove', a[i]);
            i++;
        }
        else {
            push('add', b[j]);
            j++;
        }
    }
    while (i < a.length)
        push('remove', a[i++]);
    while (j < b.length)
        push('add', b[j++]);
    return parts;
}
/**
 * Words and punctuation as separate tokens.
 *
 * Splitting on whitespace alone made "JPY." and "JPY," different tokens, so a
 * change of punctuation struck a whole word and re-inserted it — the reviewer
 * reads it as a change that was never proposed.
 */
function tokenize(text) {
    return text.replace(/\s+/g, ' ').trim().match(/[\w'’-]+|[^\s\w]|\s+/g) ?? [];
}
//# sourceMappingURL=suggestions.js.map