import { type JSX } from 'react';
/**
 * Approving a `galley auth login`.
 *
 * This screen is the whole of what the Agents panel used to do, moved to the
 * moment a person is demonstrably present. It replaces a flow where the app
 * printed a bearer token and asked somebody to carry it to a terminal — which
 * put the one irrecoverable secret in the app through a clipboard, a scrollback
 * buffer, and often a chat message.
 *
 * Nothing secret is shown here, and that is the design rather than an omission.
 * The person confirms a name and a code they can see in their own terminal; the
 * credential goes to the process that asked for it, over the channel that
 * proved it made the request.
 *
 * The decision is deliberately two-sided. A screen with only an approve button
 * teaches people that the way to make it go away is to approve it, which is
 * precisely the reflex a phished code relies on.
 */
export declare function ApproveAgent({ initialCode, viewerName, }: {
    initialCode: string | null;
    viewerName: string;
}): JSX.Element;
//# sourceMappingURL=ApproveAgent.d.ts.map