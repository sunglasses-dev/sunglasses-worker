// A sequence of rows gives the same answers under every tier of the regexp engine: the default (with tier-up), tier-up off, and
// the interpreter alone. Each run is a fresh process, since a compiled regexp is state of one isolate. The rows are seven
// as-written rows of the parity pool that the release 0.6.26 scanner blocks (some with a letter outside ASCII); the expected
// answers are fixed below. Rows: tests/fixtures/tier_up_rows.json.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const engine = fileURLToPath(new URL("../src/engine.js", import.meta.url));
const rows = fileURLToPath(new URL("./fixtures/tier_up_rows.json", import.meta.url));
const child = `import fs from "node:fs";const {scan}=await import(process.argv[1]);const rows=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));const out=[];for(const r of rows){out.push((await scan(r.text,r.channel)).decision);}console.log(out.join(","));`;
const run = (flags) => spawnSync(process.execPath, [...flags, "--input-type=module", "-e", child, "--", "file://" + engine, rows], { encoding: "utf8" });
const EXPECT = "block,block,block,block,block,block,block";
test("a sequence of rows answers the same under every tier of the regexp engine, in fresh processes", () => {
  for (const flags of [[], ["--no-regexp-tier-up"], ["--regexp-interpret-all"]]) {
    for (let k = 0; k < (flags.length ? 1 : 4); k++) {
      const r = run(flags);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), EXPECT, "flags " + flags.join(" ") + " run " + k);
    }
  }
});
