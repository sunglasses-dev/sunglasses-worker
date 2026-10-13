// The normalizer reports what it decoded, so a caller can tell a view that was
// made by decoding from one that only changed case or spacing.
//
// normalizeWithLength(text, record) returns the normalized text and the length of
// the folded plain text (the length the enrichment gate measures, before any view
// is appended), and pushes each base64 segment it replaced onto `record`. The
// negation check reads the record: it does not vouch for text past a place where
// the input could have been decoded. normalize(text) is unchanged.
//   node --test tests/preprocessor_record_hook.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.SG_WORKER_PREPROCESSOR
  || path.resolve(path.dirname(new URL(import.meta.url).pathname), "../src/preprocessor.js");
const { normalize, normalizeWithLength } = await import(pathToFileURL(modulePath).href);

const BLOB = "aGVsbG8gdGhlcmUgZnJpZW5kLCB0aGlzIGlzIGZpbGxlciB0ZXh0";   // "hello there friend, this is filler text"

test("normalize() is the first element of normalizeWithLength()", () => {
  for (const text of ["plain text here", `x ${BLOB} y`, "Café menu", "a​b  c"]) {
    assert.equal(normalize(text), normalizeWithLength(text)[0]);
  }
});

test("the length is that of the folded plain text, before any view is appended", () => {
  const [normalized, length] = normalizeWithLength("plain text here");
  assert.equal(length, "plain text here".length);
  assert.ok(normalized.length > length, "views are appended behind the plain text");
  // Whitespace collapse shrinks the text; the length is measured after it.
  assert.equal(normalizeWithLength("a      b")[1], 3);
});

test("a replaced base64 segment is recorded", () => {
  const record = [];
  const [normalized] = normalizeWithLength(`x ${BLOB} y`, record);
  assert.deepEqual(record, [BLOB]);
  assert.ok(normalized.includes("hello there friend"));
});

test("text with nothing decoded records nothing", () => {
  const record = [];
  normalizeWithLength("plain text here, nothing encoded", record);
  assert.deepEqual(record, []);
});

test("the record changes nothing else", () => {
  const text = `x ${BLOB} y`;
  assert.equal(normalizeWithLength(text, [])[0], normalizeWithLength(text)[0]);
});

test("a shadow-encoded reading is normalized with the same record", () => {
  const shadowed = [..."hi there"].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");
  const record = [];
  const [normalized] = normalizeWithLength(`ok ${shadowed}`, record);
  assert.ok(normalized.includes("hi there"));
});
