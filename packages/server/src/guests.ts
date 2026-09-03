/**
 * Names for people who have not told us theirs.
 *
 * A guest needs a name for a reason that is not cosmetic: the client hashes a
 * person's *name* to pick their presence colour, and takes the avatar letter
 * from its first character. An unnamed guest is therefore an empty circle, and
 * five guests sharing one name are five identical ones. Giving each visitor a
 * distinct label makes the existing colour logic do the right thing with no
 * change to it at all.
 */

const ADJECTIVES = [
  'Anonymous', 'Passing', 'Quiet', 'Curious', 'Patient', 'Careful',
  'Visiting', 'Attentive', 'Thoughtful', 'Diligent',
] as const;

const ANIMALS = [
  'Otter', 'Heron', 'Marten', 'Falcon', 'Badger', 'Lynx', 'Wren', 'Ibis',
  'Vole', 'Shrike', 'Tern', 'Stoat', 'Plover', 'Kestrel', 'Grebe', 'Pika',
] as const;

/**
 * Derived from the guest's id rather than random, so the same guest returning
 * on the same cookie is the same "Quiet Heron" — which is the whole point of
 * persisting the identity at all.
 */
export function guestName(guestId: string): string {
  let hash = 0;
  for (let i = 0; i < guestId.length; i++) {
    hash = (hash * 31 + guestId.charCodeAt(i)) >>> 0;
  }
  const adjective = ADJECTIVES[hash % ADJECTIVES.length]!;
  const animal = ANIMALS[Math.floor(hash / ADJECTIVES.length) % ANIMALS.length]!;
  return `${adjective} ${animal}`;
}

/** Guest principal ids are prefixed so they are obvious in an audit log. */
export function guestPrincipalId(raw: string): string {
  return `g-${raw}`;
}

export function isGuestId(id: string): boolean {
  return id.startsWith('g-');
}
