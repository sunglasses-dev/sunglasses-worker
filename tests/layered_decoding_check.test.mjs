// A reading is vouched for unless the pipeline decodes more than it shows.
//
// The scanner decodes the reading together with the raw text after it and
// compares: it stops vouching only when that gives something other than the
// reading followed by what the text decodes to alone, or when the reading is
// not a fixed point of the escape passes. The Worker answered "decodes more"
// for ANY ampersand, percent sign, backslash or tag character after a look-alike
// letter, so a negated command such as
//   Do not type "rm -rf / --no-preserve-root". <tag characters>
// was flagged at plain severity where the scanner downgrades it. The check now
// decides the way the scanner does. Two places are cautious, and both only go
// stricter, never looser: an entity-shaped reference (the scanner knows every
// HTML entity name and the Worker a subset), and a literal lone surrogate next
// to a percent escape (the URL decoder the Worker shares with the rest of the
// pipeline re-encodes the surrogate as U+FFFD, Python's keeps it).
//
// Every expectation was produced by the scanner's own engine (0.6.8).
//   node --test tests/layered_decoding_check.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const here = path.dirname(new URL(import.meta.url).pathname);
const enginePath = process.env.SG_WORKER_ENGINE || path.resolve(here, "../src/engine.js");
const { scan } = await import(pathToFileURL(enginePath).href);
const negationPath = process.env.SG_WORKER_NEGATION || path.resolve(here, "../src/negation.js");
const { Walk } = await import(pathToFileURL(negationPath).href);
const { rows } = JSON.parse(
  fs.readFileSync(path.join(here, "fixtures", "scan_corpus_layered_decoding.json"), "utf8"));
const RANK = { allow: 0, allow_redacted: 1, quarantine: 2, block: 3 };
const ids = (g) => [...new Set(g.findings.map((f) => f.id))].sort().join();

const plain = rows.filter((r) => !r.family.startsWith("control"));
const controls = rows.filter((r) => r.family.startsWith("control"));

test("the fixture holds both kinds of row", () => {
  assert.ok(plain.length >= 40 && controls.length >= 20);
});

for (const r of plain) {
  test(`${r.family} (${[...r.text].length} chars)`, () => {
    const g = scan(r.text, r.channel);
    assert.equal(g.decision, r.decision);
    assert.equal(ids(g), r.ids.join());
  });
}

// A real escape after the quote may be answered more strictly than the scanner
// does, never less.
for (const r of controls) {
  test(`${r.family}: never looser than the scanner`, () => {
    const g = scan(r.text, r.channel);
    assert.ok(RANK[g.decision] >= RANK[r.decision], `${g.decision} is weaker than ${r.decision}`);
  });
}

// The helper itself, on a literal lone surrogate as the reading with an escape
// after it. The scanner answers "no" for every one of these. The percent forms
// go stricter here (the shared decoder replaces the surrogate); the hex forms
// agree. Pinned so that either side moving is noticed.
const layered = (raw, reading) =>
  Walk.prototype.layered.call({ raw }, reading, reading.length);
const surrogateCases = [
  ["\ud800%41", "\ud800", true],
  ["\ud800%2541", "\ud800", true],
  ["\ud800%ff", "\ud800", true],
  ["\ud800%f0%9f%98%80", "\ud800", true],
  ["\udfff%41", "\udfff", true],
  ["\udfff%2541", "\udfff", true],
  ["\udfff%ff", "\udfff", true],
  ["\udfff%f0%9f%98%80", "\udfff", true],
  ["\ud800\\x41", "\ud800", false],
  ["\udfff\\x41", "\udfff", false],
];
for (const [raw, reading, stricter] of surrogateCases) {
  test(`helper: lone surrogate ${JSON.stringify(raw)} is ${stricter ? "stricter than" : "the same as"} the scanner`, () => {
    assert.equal(layered(raw, reading), stricter);
  });
}
