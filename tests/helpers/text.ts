/**
 * Text helpers for tests: a literal as a RegExp source, and the text of
 * server-rendered markup.
 */

/** `text` as RegExp source that matches it literally. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const CHARACTER_REFERENCES: Record<string, string> = { quot: '"', amp: '&', '#x27': "'", '#39': "'", lt: '<', gt: '>' };

/** Decodes the character references React's static markup emits, in one pass. */
export function decodeEntities(text: string): string {
  return text.replace(/&(quot|amp|#x27|#39|lt|gt);/g, (_, name: string) => CHARACTER_REFERENCES[name]);
}

/** The text of static markup: tags dropped, character references decoded. */
export function textContent(html: string): string {
  let text = '';
  let inTag = false;
  for (const char of html) {
    if (inTag) inTag = char !== '>';
    else if (char === '<') inTag = true;
    else text += char;
  }
  return decodeEntities(text);
}
