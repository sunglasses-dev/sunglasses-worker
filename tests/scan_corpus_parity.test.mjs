// Replay of recorded scans: the Worker must reach the scanner's decision and
// finding ids on the same text.
//
// Two fixtures. scan_corpus_068.json holds every distinct (text, channel) the
// scanner's own tests for the folded view, the negation rules and the framing
// rules scan with the stock rules, with the decision and the sorted finding ids
// the scanner returned for each. scan_corpus_negation_fuzz.json holds texts built
// around a cue (a negation, a label, a framing phrase), a payload, and a change
// to either that must not let the cue govern (invisible characters, look-alike
// letters, full-width letters, entities, percent and hex escapes, doubled spaces,
// tabs, long gaps, shadow characters, a base64 blob in front).
//
// A row marked `residual` is one the Worker stops where the scanner downgrades:
// the text decodes something (an entity or a percent escape) ahead of the cue, and
// the Worker does not vouch for text that follows a decoding step. For those rows
// the test requires the Worker to be at least as strict as the scanner, never
// looser, and the list is closed: a new residual row has to be added on purpose.
//   node --test tests/scan_corpus_parity.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const here = path.dirname(new URL(import.meta.url).pathname);
const enginePath = process.env.SG_WORKER_ENGINE || path.resolve(here, "../src/engine.js");
const { scan } = await import(pathToFileURL(enginePath).href);

const STRICTNESS = { allow: 0, allow_redacted: 1, quarantine: 2, block: 3 };
const MAX_RESIDUAL = { "scan_corpus_068.json": 1, "scan_corpus_negation_fuzz.json": 16 };

for (const file of Object.keys(MAX_RESIDUAL)) {
  const { rows } = JSON.parse(fs.readFileSync(path.join(here, "fixtures", file), "utf8"));

  test(`${file}: every row without a residual flag matches the scanner`, () => {
    const wrong = [];
    for (const row of rows) {
      if (row.residual) continue;
      const got = scan(row.text, row.channel);
      const ids = [...new Set(got.findings.map((f) => f.id))].sort();
      if (got.decision !== row.decision || ids.join() !== row.ids.join()) {
        wrong.push({ text: row.text.slice(0, 80), want: row.decision, got: got.decision });
      }
    }
    assert.deepEqual(wrong, [], `${wrong.length} of ${rows.length} rows differ`);
  });

  test(`${file}: a residual row is never looser than the scanner`, () => {
    const residual = rows.filter((r) => r.residual);
    assert.ok(residual.length <= MAX_RESIDUAL[file], "the residual list is closed");
    for (const row of residual) {
      const got = scan(row.text, row.channel);
      assert.ok(STRICTNESS[got.decision] >= STRICTNESS[row.decision],
        `${JSON.stringify(row.text.slice(0, 80))}: scanner ${row.decision}, worker ${got.decision}`);
    }
  });
}
