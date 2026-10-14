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
// decides the way the scanner does. The one cautious place is an entity-shaped
// reference: the scanner knows every HTML entity name and the Worker a subset,
// so a text that holds one still gets the cautious answer.
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
