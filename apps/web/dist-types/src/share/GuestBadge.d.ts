import type { JSX } from 'react';
/**
 * The reminder that you are a guest.
 *
 * Persistent, because the fact matters — a guest's notes are attributed to a
 * generated name and a session that ends when the link is turned off — and
 * quiet, because saying so loudly every few seconds would be nagging rather
 * than informing.
 *
 * Deliberately not violet, and deliberately not the avatar treatment agents
 * get. A guest is a person; they are simply a person nobody has vouched for
 * yet, and confusing the two would undo the one colour rule this interface
 * asks anyone to learn.
 */
export declare function GuestBadge({ name, onSignIn }: {
    name: string;
    onSignIn(): void;
}): JSX.Element;
//# sourceMappingURL=GuestBadge.d.ts.map