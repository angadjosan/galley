import type { Capability } from '../api.js';
/**
 * What each level of access lets someone do, in the words the product already
 * uses for it.
 *
 * Only four are offered. `admin` exists in the capability order and is how a
 * workspace is administered, but handing it out is not a sharing decision — a
 * picker that offers it invites someone to give away the thing that cannot be
 * taken back from a dialog whose job is "let Priya read this".
 */
export declare const SHAREABLE: readonly {
    value: Capability;
    label: string;
    blurb: string;
}[];
export declare function capabilityLabel(capability: Capability): string;
//# sourceMappingURL=capabilities.d.ts.map