// The named references the Worker decodes are the ones the pip scanner decodes: every entry of the
// interpreter's html5 table, written with and without its semicolon and with text after it, compared
// with the answer Python's html.unescape recorded for the same string.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeHtmlEntities } from "../src/preprocessor.js";

const rows = JSON.parse(readFileSync(new URL("./fixtures/html_named_references.json", import.meta.url), "utf8"));

test("every recorded string decodes to the recorded answer", () => {
  const bad = rows.filter(([input, want]) => decodeHtmlEntities(input) !== want);
  assert.deepEqual(bad.slice(0, 5), []);
  assert.equal(bad.length, 0);
});

test("the recorded set covers the whole table", () => {
  assert.ok(rows.length > 6000, String(rows.length));
});
