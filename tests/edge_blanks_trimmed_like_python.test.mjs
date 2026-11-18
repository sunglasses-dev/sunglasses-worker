// The blanks at either end of the text are trimmed the way Python's str.strip() trims them.
//
// The scanner ends the whitespace step with str.strip(), which removes U+001C, U+001D, U+001E, U+001F and
// U+0085 at an edge and keeps U+FEFF. String.prototype.trim() does the opposite on those six: it keeps the five
// and removes U+FEFF. Each row is a text, the output of the whitespace step on the scanner
// (pip 0.6.24, tag tree 704ff347) and the folded length it reports.
//   node --test tests/edge_blanks_trimmed_like_python.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../src");
const root = process.env.SG_WORKER_SRC || dir;
const { collapseWhitespace, normalizeWithLength } = await import(pathToFileURL(path.join(root, "preprocessor.js")).href);

// [label, text, collapse_whitespace(text) on the scanner, normalize_with_length(text)[1] on the scanner]
const rows = [
  ["U+001C in front", "\u001cab  cd", "ab cd", 5],
  ["U+001C behind", "ab  cd\u001c", "ab cd", 5],
  ["U+001C both ends", "\u001cab  cd\u001c", "ab cd", 5],
  ["U+001C two in front", "\u001c\u001cab  cd", "ab cd", 5],
  ["U+001D in front", "\u001dab  cd", "ab cd", 5],
  ["U+001D behind", "ab  cd\u001d", "ab cd", 5],
  ["U+001D both ends", "\u001dab  cd\u001d", "ab cd", 5],
  ["U+001D two in front", "\u001d\u001dab  cd", "ab cd", 5],
  ["U+001E in front", "\u001eab  cd", "ab cd", 5],
  ["U+001E behind", "ab  cd\u001e", "ab cd", 5],
  ["U+001E both ends", "\u001eab  cd\u001e", "ab cd", 5],
  ["U+001E two in front", "\u001e\u001eab  cd", "ab cd", 5],
  ["U+001F in front", "\u001fab  cd", "ab cd", 5],
  ["U+001F behind", "ab  cd\u001f", "ab cd", 5],
  ["U+001F both ends", "\u001fab  cd\u001f", "ab cd", 5],
  ["U+001F two in front", "\u001f\u001fab  cd", "ab cd", 5],
  ["U+0085 in front", "\u0085ab  cd", "ab cd", 5],
  ["U+0085 behind", "ab  cd\u0085", "ab cd", 5],
  ["U+0085 both ends", "\u0085ab  cd\u0085", "ab cd", 5],
  ["U+0085 two in front", "\u0085\u0085ab  cd", "ab cd", 5],
  ["U+FEFF in front", "\ufeffab  cd", "\ufeffab cd", 5],
  ["U+FEFF behind", "ab  cd\ufeff", "ab cd\ufeff", 5],
  ["U+FEFF both ends", "\ufeffab  cd\ufeff", "\ufeffab cd\ufeff", 5],
  ["U+FEFF two in front", "\ufeff\ufeffab  cd", "\ufeff\ufeffab cd", 5],
  ["U+00A0 in front", "\u00a0ab  cd", "ab cd", 5],
  ["U+00A0 behind", "ab  cd\u00a0", "ab cd", 5],
  ["U+00A0 both ends", "\u00a0ab  cd\u00a0", "ab cd", 5],
  ["U+00A0 two in front", "\u00a0\u00a0ab  cd", "ab cd", 5],
  ["U+2028 in front", "\u2028ab  cd", "ab cd", 5],
  ["U+2028 behind", "ab  cd\u2028", "ab cd", 5],
  ["U+2028 both ends", "\u2028ab  cd\u2028", "ab cd", 5],
  ["U+2028 two in front", "\u2028\u2028ab  cd", "ab cd", 5]
];
for (const [label, text, collapsed, folded] of rows) {
  test(`whitespace step, ${label}`, () => {
    assert.equal(collapseWhitespace(text), collapsed);
  });
  test(`folded length, ${label}`, () => {
    assert.equal(normalizeWithLength(text)[1], folded);
  });
}
