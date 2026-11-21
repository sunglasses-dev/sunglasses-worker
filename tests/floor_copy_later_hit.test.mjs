// A rule's floor copy is read from an offset like any other regex.
//
// A rule that opens with a negative lookahead has a floor copy: the same regexes with the guard taken out, one step
// lower. When a cue stands in front of the words, the walk looks for a later occurrence in that copy from an offset,
// and every plain entry of the copy carries the regex for that read. The texts below are a cue and the words of four
// such rules: each answers, the scanner lowers each to allow_redacted, and the words alone stop. A last test holds the
// same for every entry of every rule and floor copy, in every mode.
//   node --test tests/floor_copy_later_hit.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const enginePath = process.env.SG_WORKER_ENGINE
  || path.resolve(path.dirname(new URL(import.meta.url).pathname), "../src/engine.js");
const { scan } = await import(pathToFileURL(enginePath).href);

const WORDS = ["dtmf override", "phonetic code ignore", "execute tool in background", "run connector silently"];
const CUES = ["never", "do not", "don't"];
const CHANNELS = ["file", "tool_output", "web_content"];

test("the words alone stop on every channel", () => {
  for (const ch of CHANNELS) for (const w of WORDS) assert.equal(scan(w, ch).decision, "block", `${w} ${ch}`);
});

test("a cue and the words answer, and answer as the scanner does", () => {
  for (const ch of CHANNELS) {
    for (const cue of CUES) {
      for (const w of WORDS) {
        let answer;
        assert.doesNotThrow(() => { answer = scan(`${cue} ${w}`, ch).decision; }, `${cue} ${w} ${ch}`);
        assert.equal(answer, "allow_redacted", `${cue} ${w} ${ch}`);
      }
    }
  }
});

// Every entry of every rule and of every floor copy carries the regex that reads from an offset.
const { walkableEntries } = await import(pathToFileURL(enginePath).href);

test("every entry of every rule and of every floor copy carries the regex that reads from an offset", () => {
  const entries = walkableEntries();
  const modes = new Set();
  let floors = 0;
  for (const { id, floor, entry } of entries) {
    modes.add(entry.mode);
    if (floor) floors++;
    const where = `${id} ${floor ? "floor copy" : "rule"} ${entry.mode}`;
    assert.ok(entry.rxFrom instanceof RegExp, `${where}: no offset regex`);
    assert.ok(entry.rxFrom.global, `${where}: the offset regex is not a global regex`);
    assert.equal(entry.rxFrom.source, entry.rx.source, `${where}: the offset regex is another regex`);
  }
  assert.ok(floors > 500, `the floor copies are walked too (${floors})`);
  for (const mode of ["plain", "windowed", "windowed_edges", "guarded", "anchored", "leadin"]) {
    assert.ok(modes.has(mode), `the walk reaches entries of mode ${mode}`);
  }
});
