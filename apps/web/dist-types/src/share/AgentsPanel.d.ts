import { type JSX } from 'react';
/**
 * The agents you have set up.
 *
 * Violet everywhere, because violet already means "not a person" everywhere
 * else in this app and an admin screen is exactly where that association has
 * to hold. Nothing here is decorated with it; the rows *are* agents.
 *
 * Two rules the interface has to make visible rather than merely obey:
 *
 * - **An agent never registers itself.** It exists because a named human made
 *   it, and it acts with that human's authority, narrowed to a path.
 * - **The token is shown once.** Not because it is dramatic, but because a
 *   secret a server can re-read is a secret the server can leak. The line
 *   saying so is next to the token, before it disappears — not in a tooltip
 *   afterwards.
 */
export declare function AgentsPanel({ sponsorName }: {
    sponsorName: string;
}): JSX.Element;
//# sourceMappingURL=AgentsPanel.d.ts.map