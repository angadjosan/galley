/**
 * The names the parser invents for anything unnamed.
 *
 * Shared by the parser and the serializer on purpose. They have to agree
 * exactly: the parser fills a missing name in, and the serializer drops a name
 * that matches what the parser would have filled in. If the two ever disagree,
 * either a design grows a `name=` attribute nobody typed on its first save, or
 * an author's explicit name is thrown away.
 */

export function defaultFrameName(index: number): string {
  return `Frame ${index + 1}`;
}

export function defaultLayerName(kind: 'box' | 'text' | 'image' | 'use', childCount: number): string {
  if (kind === 'text') return 'Text';
  if (kind === 'image') return 'Image';
  if (kind === 'use') return 'Use';
  return childCount > 0 ? 'Group' : 'Box';
}

/**
 * Whether a name is one the parser *could* have invented for this kind.
 *
 * Not "the one it would invent now". A box's invented name depends on its child
 * count, so deleting the last child of an unnamed box flipped it from "Group"
 * to "Box" — and the serializer, comparing against the current count, started
 * writing `name="Group"` onto a line nobody had touched. That is the exact
 * failure this module exists to prevent, arriving through the back door.
 *
 * The cost is that a box explicitly named "Group" loses the attribute on save.
 * That is the right trade: the name carries no information the parser would not
 * have supplied anyway, and the alternative is a diff nobody can explain.
 */
export function isInventedName(kind: 'box' | 'text' | 'image' | 'use', name: string): boolean {
  if (kind === 'box') return name === 'Box' || name === 'Group';
  return name === defaultLayerName(kind, 0);
}
