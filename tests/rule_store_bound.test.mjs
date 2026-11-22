import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// THE MEMORY BOUND OF THE STORE, on the all-rules case. Every regex of every rule is held through the one store, which
// holds at most its budget of source characters (plus the one regex just read); the form a text is read in changes how
// many characters a regex has, never the budget. This runs the all-rules case in a child with the heap capped at 128 MB, the
// way an isolate runs: every floor copy built, then scans of a text that holds every rule's words, once with every letter in ASCII and once
// with a letter outside it (each fills the store the other way), with the live heap read after a full collection each time.
const ENGINE = new URL("../src/engine.js", import.meta.url).href;
const CHILD = `
const e = await import(process.argv[1]);
const { PATTERNS } = await import(new URL("./patterns.js", process.argv[1]).href);
const { MECHANISMS } = await import(new URL("./mechanisms.js", process.argv[1]).href);
const mb = () => { global.gc(); return Math.round(process.memoryUsage().heapUsed / 1048576); };
const base = mb();
let worst = base, widest = 0;
const note = () => { worst = Math.max(worst, mb()); widest = Math.max(widest, e.ruleStoreStats().chars); };
// every rule's own words: its keywords and its required literals, so every rule runs
const words = [];
for (const p of [...PATTERNS, ...MECHANISMS]) {
  for (const k of p.keywords || []) words.push(k);
  for (const r of p.regex || []) for (const q of r.requires || []) if (typeof q === "string") words.push(q);
}
const uniq = [...new Set(words)].filter((x) => x.length > 2);
let all = "";
for (const w of uniq) { if (all.length + w.length + 1 > 99000) break; all += w + " "; }
e.buildAllFloors(); note();
for (let k = 0; k < 3; k++) {
  await e.scan(all, "file"); note();                    // every letter ASCII: the ASCII form
  await e.scan(all + " caf\\u00e9", "file"); note();      // a letter outside ASCII: the full form, every rule again
}
console.log(JSON.stringify({ base_mb: base, worst_live_mb: worst, widest_chars: widest, budget: e.ruleStoreStats().budget, dead: e.DEAD_REGEX_IDS.length, words: uniq.length }));
`;

test("the all-rules case under a 128 MB heap cap holds the store to its budget and the live heap under 90 MB, in both forms", () => {
  const r = spawnSync(process.execPath, ["--max-old-space-size=128", "--expose-gc", "--input-type=module", "-e", CHILD, ENGINE],
    { encoding: "utf8", timeout: 240_000 });
  assert.equal(r.status, 0, "the all-rules case did not finish under the cap: " + (r.stderr || "").slice(0, 300));
  const got = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.equal(got.dead, 0);
  assert.ok(got.words > 1000, "the all-rules text holds every rule's words: " + got.words);
  assert.ok(got.budget <= 500_000, "the store budget is the bound the heap row was measured at (500,000), not above it: " + got.budget);
  assert.ok(got.widest_chars <= got.budget + 20_000, "the store held " + got.widest_chars + " source characters, budget " + got.budget);
  assert.ok(got.worst_live_mb <= 90, "live heap " + got.worst_live_mb + " MB");
  console.log("all-rules case, 128 MB cap: live heap " + got.worst_live_mb + " MB (base " + got.base_mb + "), store at most " + got.widest_chars + " of " + got.budget + " characters");
});
