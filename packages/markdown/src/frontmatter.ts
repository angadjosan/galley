import { parseDocument as parseYamlDocument } from 'yaml';
import type { ParsedDocument } from './types.js';
import { applyTextEdits, lineEndAt, type TextEdit } from './splice.js';

/**
 * Set or update keys in a document's YAML frontmatter, preserving everything
 * else about it — key order, comments, quoting style, indentation.
 *
 * This matters more than it sounds. `galley:` has to be written into every
 * document Galley touches (it is the identity that survives a rename), and a
 * naive "parse YAML, mutate, dump" would reformat a user's carefully ordered
 * frontmatter on first contact. The `yaml` package's document model edits in
 * place and re-emits only what changed, which is the same principle as the
 * block splicer one level down.
 */
export function setFrontmatterKeys(
  doc: ParsedDocument,
  entries: Readonly<Record<string, unknown>>,
): string {
  const eol = doc.style.eol;
  const keys = Object.entries(entries);
  if (keys.length === 0) return doc.source;

  if (!doc.frontmatter) {
    const lines = keys.map(([key, value]) => `${key}: ${formatScalar(value)}`);
    const block = `---${eol}${lines.join(eol)}${eol}---${eol}${eol}`;
    return `${block}${doc.source}`;
  }

  const yamlDoc = parseYamlDocument(doc.frontmatter.raw);
  for (const [key, value] of keys) {
    if (value === undefined || value === null) yamlDoc.delete(key);
    else yamlDoc.set(key, value);
  }
  let emitted = yamlDoc.toString({ lineWidth: 0 }).replace(/\n$/, '');
  if (eol === '\r\n') emitted = emitted.replace(/\n/g, '\r\n');

  const edit: TextEdit = {
    range: doc.frontmatter.range,
    text: emitted,
    label: 'frontmatter',
  };
  return applyTextEdits(doc.source, [edit]);
}

/** Remove the frontmatter block and its trailing blank line. */
export function stripFrontmatter(doc: ParsedDocument): string {
  if (!doc.frontmatter) return doc.source;
  let end = lineEndAt(doc.source, doc.frontmatter.range.end);
  const nextLineEnd = lineEndAt(doc.source, end);
  if (doc.source.slice(end, nextLineEnd).trim() === '' && nextLineEnd > end) end = nextLineEnd;
  return applyTextEdits(doc.source, [{ range: { start: 0, end }, text: '', label: 'strip frontmatter' }]);
}

function formatScalar(value: unknown): string {
  if (typeof value === 'string') {
    return /^[A-Za-z0-9_./-]+$/.test(value) ? value : JSON.stringify(value);
  }
  return JSON.stringify(value);
}
