// A rule's spans and decisions, held to the scanner's answer on every tier of the regexp engine.
//
// Each tests/fixtures/scan_corpus_rule_span_grid*.json holds, for one rule, the answers the scanner (pip) gave on the products of the scanner's own
// span test for the rule (made by tools/make_rule_span_grid.py, which reads those products by code): for each text, the decision on
// each channel the rule declares, and the text the rule matched. The Worker must give the same decision on each channel and the
// same matched text. Each tier is a fresh process, since a compiled regexp is state of one isolate: the default (with tier-up),
// tier-up off, and the interpreter alone. One grid per rule; a new file of the same name pattern is picked up.
//   node --test tests/rule_span_grid.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const engine = fileURLToPath(new URL("../src/engine.js", import.meta.url));
const dir = fileURLToPath(new URL("./fixtures/", import.meta.url));
const grids = fs.readdirSync(dir).filter((f) => /^scan_corpus_rule_span_grid(_\d+)?\.json$/.test(f)).sort();
const child = `import fs from "node:fs";const {scan}=await import(process.argv[1]);const g=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
const L=g.decision_letters;const bad=[];let seen=0,hit=0;
for(let i=0;i<g.rows.length;i++){const [text,code,matched]=g.rows[i];let c="",m=null;
for(const ch of g.channels){const r=scan(text,ch);c+=L[r.decision];const f=r.findings.find((x)=>x.id===process.argv[3]);if(f)m=f.matched_text;}
seen++;if(m!==null)hit++;if(c!==code||m!==matched)bad.push(i);}
console.log(JSON.stringify({seen,hit,bad:bad.length,first:bad.slice(0,5)}));`;
const run = (flags, grid, ruleId) => spawnSync(process.execPath, [...flags, "--input-type=module", "-e", child, "--", "file://" + engine, grid, ruleId],
  { encoding: "utf8", maxBuffer: 1 << 24, timeout: 540000 });
test("the grids are there", () => {
  assert.ok(grids.length >= 2, grids.join());
});

for (const file of grids) {
  const grid = dir + file;
  const g = JSON.parse(fs.readFileSync(grid, "utf8"));

  test(`${file}: the grid is the scanner's, with matches and with texts that match nothing`, () => {
    assert.equal(g.rows.length, g.texts);
    assert.ok(g.texts_with_a_match > 1000 && g.texts - g.texts_with_a_match > 1000);
    assert.match(g.rule, /^GLS-[A-Z0-9-]+$/);
    assert.ok(Array.isArray(g.channels) && g.channels.length > 0);
  });

  for (const flags of [[], ["--no-regexp-tier-up"], ["--regexp-interpret-all"]]) {
    test(`${file}: every text answers as the scanner does on every channel, tier: ${flags.join(" ") || "default"}`, () => {
      const r = run(flags, grid, g.rule);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout.trim());
      assert.equal(out.seen, g.texts);
      assert.equal(out.hit, g.texts_with_a_match);
      assert.equal(out.bad, 0, `${out.bad} of ${out.seen} texts differ, first rows ${out.first}`);
    });
  }
}
