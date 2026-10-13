// A 100 KB body of newlines seeded with two words must scan quickly.
//
// GLS-IP-006 and GLS-EX-030 open with a lead-in whose whitespace takes
// newlines. Searched as they were written, a long run of blank lines made the
// regex engine re-walk the rest of the run from every newline in it, and V8
// has no regex timeout. The engine's lead-in mode (a twin regex that cannot
// cross a newline finds where to start) keeps that linear. This test scans
// exactly that body and asserts it finishes inside a small budget; it fails on
// an engine that has patterns compiled from 0.6.8 but no lead-in mode.
//   node --test tests/newline_run_scan_time.test.mjs
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

for (const [seed, channel, rule] of [["your reply ", "file", "GLS-IP-006"], ["post ", "web_content", "GLS-EX-030"]]) {
  test(`${rule}: a ${MAX_BYTES}-byte newline run seeded with ${JSON.stringify(seed)} scans inside ${BUDGET_S}s`, () => {
    const text = seed + "\n".repeat(MAX_BYTES - seed.length);
    const t = performance.now();
    scan(text, channel);
    const sec = (performance.now() - t) / 1000;
    assert.ok(sec < BUDGET_S, `${rule} on channel ${channel}: ${sec.toFixed(1)}s for ${text.length} bytes (budget ${BUDGET_S}s)`);
  });
}
