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

export function defaultLayerName(kind: 'box' | 'text' | 'image', childCount: number): string {
  if (kind === 'text') return 'Text';
  if (kind === 'image') return 'Image';
  return childCount > 0 ? 'Group' : 'Box';
}
