// A base64-looking run is decoded only when the scanner decodes it.
//
// The scanner reads a run of 20 or more base64 characters with Python's
// b64decode, which refuses a run whose padding cannot complete the last group
// and then leaves the run as written. JS atob() is more forgiving: it accepts a
// run with no padding at all and refuses surplus padding. Two things followed.
// A run the scanner keeps could be turned into noise here, which destroyed a
// phrase written in it (a reversed text holds a 23 character run of letters and
// a slash), and a run the scanner decodes could be left as written.
//
// The decode also has to agree on what counts as a printable result and on the
// length of it: the scanner counts code points, drops invalid bytes but keeps a
// genuine replacement character, and refuses control, format, separator and
// unassigned characters.
//
// Every expectation below was produced by the scanner's own function (0.6.8).
//   node --test tests/base64_segment_padding.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const here = path.dirname(new URL(import.meta.url).pathname);
const modulePath = process.env.SG_WORKER_PREPROCESSOR || path.resolve(here, "../src/preprocessor.js");
const enginePath = process.env.SG_WORKER_ENGINE || path.resolve(here, "../src/engine.js");
const { decodeBase64Segments } = await import(pathToFileURL(modulePath).href);
const { scan } = await import(pathToFileURL(enginePath).href);
const { rows } = JSON.parse(
  fs.readFileSync(path.join(here, "fixtures", "scan_corpus_base64_padding.json"), "utf8"));

const wrap = (run) => `x ${run} y`;
const decoded = (run) => {
  const seen = [];
  return [decodeBase64Segments(wrap(run), seen), seen];
};

// "hello there friend, 1" / ", 12" / ", 123" encode to 28 characters with 0, 2 and 1 pad.
const ONE = "aGVsbG8gdGhlcmUgZnJpZW5kLCAx";
const TWO = "aGVsbG8gdGhlcmUgZnJpZW5kLCAxMg==";
const THREE = "aGVsbG8gdGhlcmUgZnJpZW5kLCAxMjM=";

test("a run with the padding it needs is decoded", () => {
  assert.deepEqual(decoded(ONE), ["x hello there friend, 1 y", [ONE]]);
  assert.deepEqual(decoded(TWO), ["x hello there friend, 12 y", [TWO]]);
  assert.deepEqual(decoded(THREE), ["x hello there friend, 123 y", [THREE]]);
});

test("a run whose padding cannot complete the last group is left as written", () => {
  // The same runs with the padding removed or cut short.
  for (const run of [TWO.slice(0, -2), TWO.slice(0, -1), THREE.slice(0, -1)]) {
    assert.deepEqual(decoded(run), [wrap(run), []], run);
  }
  // One character left over in the last group never decodes.
  assert.deepEqual(decoded(ONE + "A"), [wrap(ONE + "A"), []]);
});

test("a letters-and-slash run that is not padded is left alone", () => {
  const run = "etartlifxe/dnes/drawroF";
  assert.equal(run.length, 23);
  assert.deepEqual(decoded(run), [wrap(run), []]);
});

test("padding beyond what the last group needs is ignored", () => {
  assert.deepEqual(decoded(ONE + "="), ["x hello there friend, 1 y", [ONE + "="]]);
  assert.deepEqual(decoded(ONE + "=="), ["x hello there friend, 1 y", [ONE + "=="]]);
  assert.deepEqual(decoded(THREE + "="), ["x hello there friend, 123 y", [THREE + "="]]);
});

test("the result is judged the way the scanner judges it", () => {
  const cases = [
    // four code points is not more than four, five is
    ["8J+YgPCfmIDwn5iA8J+YgA==", false],
    ["8J+YgPCfmIDwn5iA8J+YgPCfmIA=", true],
    // a byte order mark, a zero width space, a no-break space and an unassigned
    // character each make the result non-printable
    ["77u/aGVsbG8gdGhlcmUgZnJpZW5k", false],
    ["aGVsbG/igIt0aGVyZSBmcmllbmQ=", false],
    ["aGVsbG/CoHRoZXJlIGZyaWVuZA==", false],
    ["aGVsbG8gzbggdGhlcmUgZnJpZW5k", false],
    // a replacement character that was part of the text stays
    ["ZmZmZCDvv70gY2hhciBpbnNpZGUgdGV4dA==", true],
  ];
  for (const [run, replaced] of cases) {
    const [out, seen] = decoded(run);
    assert.equal(seen.length === 1, replaced, run);
    assert.equal(out !== wrap(run), replaced, run);
  }
  assert.equal(decoded("ZmZmZCDvv70gY2hhciBpbnNpZGUgdGV4dA==")[0], "x fffd � char inside text y");
});

// Texts the scanner reads one way and the Worker read another because of the
// padding of a run in them; both the padded and the unpadded forms of the run.
for (const family of ["reversed_text_with_unpadded_alphabet_run", "encoded_payload_padding_states", "plain_control"]) {
  const group = rows.filter((r) => r.family === family);
  test(`${family}: ${group.length} rows reach the scanner's decision and finding ids`, () => {
    assert.ok(group.length >= 1);
    const wrong = [];
    for (const row of group) {
      const got = scan(row.text, row.channel);
      const ids = [...new Set(got.findings.map((f) => f.id))].sort();
      if (got.decision !== row.decision || ids.join() !== row.ids.join()) {
        wrong.push({ text: row.text.slice(0, 60), want: row.decision, got: got.decision });
      }
    }
    assert.deepEqual(wrong, []);
  });
}
