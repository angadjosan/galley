import { type JSX } from 'react';
/**
 * Who can open this document, and how to change that.
 *
 * The dialog is a list first and a form second, because the question people
 * actually arrive with is "who has this?" — and an interface that answers it
 * only after you have typed something is an interface that makes you guess.
 *
 * The one piece of copy here that earns its length is the outcome of adding
 * someone. "Shared" and "Invited" are different facts: the first means a
 * colleague can open the document now, the second means nothing happens until
 * a stranger signs up. Collapsing them into "Done" is how a document quietly
 * fails to reach the person it was meant for.
 */
export declare function ShareDialog({ docRef, }: {
    /** What the routes address this document by. */
    docRef: string;
}): JSX.Element;
//# sourceMappingURL=ShareDialog.d.ts.map