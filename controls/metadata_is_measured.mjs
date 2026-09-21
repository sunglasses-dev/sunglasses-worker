// CONTROL: every key the contract calls metadata, proven inert against the engine.
//
// pattern_field_contract.json splits the source keys into `consulted` and
// `metadata`, and its comment says metadata is "consulted by nothing" and the
// compiler "MAY drop these". Round 2 shipped that sentence as an ASSERTION. It
// was wrong about three of its four keys, and gate (c) was green for all of
// them, because (c) grades what the contract says rather than what the engine
// does. Measured here 2026-09-21 against the parity corpus:
//
//     mechanism    0 id-delta   0 record-delta   0 decision-delta   inert
//     name         0 id-delta  43 record-delta   0 decision-delta   emitted
//     description  0 id-delta  43 record-delta   0 decision-delta   emitted
//     category    11 id-delta  43 record-delta   0 decision-delta   CONSULTED
//
// `category` reaches control flow twice -- engine.js:588/593 suppress a
// mechanism when a carrier of the SAME category already fired at >= severity,
// and policy.js:73 groups findings by category for corroboration. Delete it and
// GLS-MECH-001 stops being suppressed in 11 of 136 cases. `name` and
// `description` never steer a decision but are copied onto every finding
// (engine.js:423/426), so dropping them rewrites the JSON a consumer reads.
//
// So the classification is no longer taken on anyone's word. For each remaining
// metadata key this deletes it from the compiled rule set and requires the
// engine's output to be byte-identical over the corpus. A key that changes
// anything is consulted, and the gate says so and fails. This control is the
// reason the contract can be trusted; without it "metadata" is a claim.
//
// One child process per key: five engines in one process exhausts the V8 heap
// (1,587 compiled regex sets each), and an OOM would read as a gate failure.
import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const contract = JSON.parse(readFileSync(join(root, "pattern_field_contract.json"), "utf8"));
const keys = contract.metadata.keys;

if (!keys.length) {
  console.log("  contract declares no metadata keys; nothing to prove.");
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), "metadata-control-"));
try {
  const cases = join(work, "cases.json");
  // The corpus comes from the parity gate itself, never a copy of it.
  execFileSync("python3", [join(root, "engine_parity.py"), "--dump-cases", cases],
    { cwd: root, stdio: "pipe" });
  const n = JSON.parse(readFileSync(cases, "utf8")).length;

  cpSync(join(root, "src"), join(work, "base"), { recursive: true });
  writeFileSync(join(work, "base", "package.json"), '{"type":"module"}');

  console.log(`  corpus: ${n} cases from engine_parity.py --dump-cases`);
  let bad = 0;
  for (const key of keys) {
    const mut = join(work, `mut_${key}`);
    cpSync(join(root, "src"), mut, { recursive: true });
    writeFileSync(join(mut, "package.json"), '{"type":"module"}');
    const pj = join(mut, "patterns.js");
    writeFileSync(pj, readFileSync(pj, "utf8") + `\nfor (const p of PATTERNS) delete p.${key};\n`);

    const out = execFileSync("node", [join(here, "_metadata_one_key.mjs"), work, key, cases],
      { encoding: "utf8" });
    const r = JSON.parse(out);
    const inert = r.idDelta === 0 && r.recordDelta === 0 && r.decisionDelta === 0;
    console.log(`  ${key.padEnd(14)} id ${String(r.idDelta).padStart(3)}  record ${String(r.recordDelta).padStart(3)}  decision ${String(r.decisionDelta).padStart(3)}  ${inert ? "inert" : "NOT INERT"}`);
    if (!inert) {
      bad++;
      // Say which kind it is. A key that steers the engine and a key that is
      // merely copied onto the output are both wrongly filed here, but they are
      // not the same defect, and one sentence covering both would overstate one
      // of them.
      if (r.idDelta || r.decisionDelta) {
        console.log(`      deleting \`${key}\` changed WHICH findings fire. It reaches control`);
        console.log(`      flow; the contract calls it metadata. Move it to \`consulted\`.`);
      } else {
        console.log(`      deleting \`${key}\` changed ${r.recordDelta} finding record(s) without`);
        console.log(`      changing any decision: it is EMITTED on every finding, so dropping it`);
        console.log(`      rewrites the JSON a consumer reads. Move it to \`consulted\`, or state`);
        console.log(`      here why a consumer losing this field is acceptable.`);
      }
      if (r.examples.length) console.log(`      first cases: ${JSON.stringify(r.examples)}`);
    }
  }
  if (bad) { console.log(`\n  METADATA CONTRACT FAIL — ${bad} of ${keys.length} key(s) are not inert`); process.exit(1); }
  console.log(`  METADATA CONTRACT OK — ${keys.length} key(s) proven inert on ${n} cases`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
