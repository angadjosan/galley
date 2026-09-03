import { type JSX } from 'react';
/**
 * The agents you have approved.
 *
 * Violet everywhere, because violet already means "not a person" everywhere
 * else in this app and an admin screen is exactly where that association has
 * to hold. Nothing here is decorated with it; the rows *are* agents.
 *
 * This screen used to mint tokens, and no longer does. An agent asks for
 * itself, by name, through `galley auth login`, and a person approves it on the
 * approval screen — which is the same delegation, performed at the moment the
 * human is demonstrably present, and without a secret ever crossing a
 * clipboard. What is left here is the half that was always the point: seeing
 * what has access, and taking it away.
 *
 * The rule the interface still has to make visible rather than merely obey:
 * **an agent never registers itself.** Every row exists because a named human
 * said yes, and acts with that human's authority.
 */
export declare function AgentsPanel(): JSX.Element;
//# sourceMappingURL=AgentsPanel.d.ts.map