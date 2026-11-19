// The structural readers (hook commands, settings files, shell scripts) answer each text as the scanner's readers do.
// Each row is a text and the answer the scanner gave for it: the matched text and the evidence, or no finding.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VALIDATORS, runValidators } from "../src/validators.js";
import { scan } from "../src/engine.js";

const ROWS = JSON.parse(readFileSync(new URL("./fixtures/structural_reader_rows.json", import.meta.url), "utf8"));
const byId = new Map(VALIDATORS.map((v) => [v.id, v]));

function answer(validator, text) {
  if (!validator.pregate(text)) return [];
  return validator.run(text).map((f) => [f.matched_text, f.evidence, f.id, f.severity]);
}

for (const [id, label] of [
  ["GLS-STRUCT-001", "hook commands"],
  ["GLS-STRUCT-004", "settings files"],
  ["GLS-STRUCT-005", "python programs"],
  ["GLS-STRUCT-006", "shell scripts"],
]) {
  test(`${label} are read as the scanner reads them`, () => {
    const validator = byId.get(id);
    assert.ok(validator, "the reader is registered");
    for (const [text, expected] of ROWS[id]) {
      assert.deepEqual(answer(validator, text), expected, JSON.stringify(text).slice(0, 200));
    }
  });
}

test("a scan carries the finding of a reader, with its evidence, on the channels it reads", () => {
  for (const [id, channel] of [["GLS-STRUCT-001", "file"], ["GLS-STRUCT-004", "file"], ["GLS-STRUCT-005", "code"], ["GLS-STRUCT-006", "code"]]) {
    const [text, expected] = ROWS[id].find(([, e]) => e.length);
    const result = scan(text, channel);
    const found = result.findings.find((f) => f.id === id);
    assert.ok(found, id);
    assert.deepEqual(found.evidence, expected[0][1]);
    assert.equal(found.structural, true);
  }
});

test("a reader reads only the channels it names", () => {
  const validator = byId.get("GLS-STRUCT-006");
  const [text] = ROWS["GLS-STRUCT-006"].find(([, e]) => e.length);
  assert.equal(runValidators(text, ["message"]).filter((f) => f.id === validator.id).length, 0);
  assert.equal(runValidators(text, ["code"]).filter((f) => f.id === validator.id).length, 1);
});

test("a reader that throws leaves the scan standing", () => {
  const original = byId.get("GLS-STRUCT-004").run;
  byId.get("GLS-STRUCT-004").run = () => {
    throw new Error("broken");
  };
  try {
    assert.doesNotThrow(() => scan('{"permissions": {"defaultMode": "bypassPermissions"}}', "file"));
  } finally {
    byId.get("GLS-STRUCT-004").run = original;
  }
});
