/**
 * What each level of access lets someone do, in the words the product already
 * uses for it.
 *
 * Only four are offered. `admin` exists in the capability order and is how a
 * workspace is administered, but handing it out is not a sharing decision — a
 * picker that offers it invites someone to give away the thing that cannot be
 * taken back from a dialog whose job is "let Priya read this".
 */
export const SHAREABLE = [
    { value: 'read', label: 'Can read', blurb: 'Open it and read it. Nothing else.' },
    { value: 'comment', label: 'Can comment', blurb: 'Leave notes in the margin.' },
    { value: 'suggest', label: 'Can suggest', blurb: 'Propose edits for someone to accept.' },
    { value: 'write', label: 'Can edit', blurb: 'Change the document directly.' },
];
export function capabilityLabel(capability) {
    return SHAREABLE.find((entry) => entry.value === capability)?.label ?? 'Full access';
}
//# sourceMappingURL=capabilities.js.map