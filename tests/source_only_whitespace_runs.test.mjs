// A 100 KB run of spaces inside GLS-AW-001 and GLS-SQLFS-001 must scan quickly.
//
// Scanner 0.6.8 rewrote both rules (#354, #357) so a long run of blank space
// after the fetch verb, or after the opening bracket of a SQL read primitive,
// no longer costs the square of its length. The fixes are in the rule source
// only, so patterns compiled from 0.6.8 carry them and the 0.6.7 compile does
// not.
//
// The suffix matters: engine.js skips a regex when the document lacks one of
// its required literals (canSkip), so the body carries a word from every
// clause of the rule's requirement, placed where the regex still cannot match.
// A run of spaces, not newlines, so the lead-in rules stay out of the timing.
//   node --test tests/source_only_whitespace_runs.test.mjs
//   SG_WORKER_ENGINE=/path/to/src/engine.js node --test ...
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const enginePath = process.env.SG_WORKER_ENGINE
  || path.resolve(path.dirname(new URL(import.meta.url).pathname), "../src/engine.js");
const { scan } = await import(pathToFileURL(enginePath).href);

const BUDGET_S = 2.0;
const MAX_BYTES = 100_000; // index.js request cap

const CASES = [
  // rule, channel, prefix, suffix
  ["GLS-AW-001", "message", "fetch ", " publish the page"],
  ["GLS-SQLFS-001", "message", "pg_read_file(", ")/etc/passwd"],
];

for (const [rule, channel, prefix, suffix] of CASES) {
  test(`${rule}: a ${MAX_BYTES}-byte space run after ${JSON.stringify(prefix)} scans inside ${BUDGET_S}s`, () => {
    const text = prefix + " ".repeat(MAX_BYTES - prefix.length - suffix.length) + suffix;
    const t = performance.now();
    scan(text, channel);
    const sec = (performance.now() - t) / 1000;
    assert.ok(sec < BUDGET_S, `${rule} on channel ${channel}: ${sec.toFixed(1)}s for ${text.length} bytes (budget ${BUDGET_S}s)`);
  });
}
