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
// metadata key this deletes it from the compiled rule set and compares the
// engine's finding IDs, finding RECORDS and decision over the corpus. A key
// that changes any of the three is consulted, and the gate says so and fails.
//
// WHAT THIS DOES NOT SAY, corrected after ASTRA round 3: it is not "proven
// inert". 136 cases cannot establish universal inertness, and the comparison is
// those three things rather than byte-identical complete engine output. The
// gate is bounded by its corpus and its summary line says so. A gate that
// overstates its own reach is the same defect as the contract sentence it
// exists to replace, one level up.
//
// The DERIVATION found none of this because it scopes the Python matcher while
// these read sites are in the JS Worker engine. That is a boundary of the
// derivation AS IT EXISTS, not a proof that no static analysis could find them
// -- ASTRA's correction, and he is right: the analysis could be extended to the
// Worker source. Executing the artefact is one kind of evidence for a read
// site, not the only kind.
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

// `--contract <path>` exists because a control that can only be pointed at the
// CURRENT contract cannot be shown failing. ASTRA, round 3: "A green-only
// control has baseline/smoke value but does not prove detection of the defect",
// and with new scripts prohibited he could not assemble the red run himself, so
// the red-first stayed author-reported. Now it is one argument:
//     node controls/metadata_is_measured.mjs --contract <r2head>/pattern_field_contract.json
// must FAIL naming category, name and description, and it must fail for the
// measured deltas rather than an import error, a missing file or an OOM --
// which is why every load failure below exits 2 and every measured failure
// exits 1.
const argI = process.argv.indexOf("--contract");
const contractPath = argI > -1 ? process.argv[argI + 1]
                               : join(root, "pattern_field_contract.json");
if (argI > -1 && !contractPath) {
  console.log("  --contract needs a path to a pattern_field_contract.json");
  process.exit(2);
}
let contract;
try {
  contract = JSON.parse(readFileSync(contractPath, "utf8"));
} catch (e) {
  console.log(`  cannot read the contract at ${contractPath}: ${e.message}`);
  process.exit(2);
}
if (!Array.isArray(contract?.metadata?.keys)) {
  console.log(`  ${contractPath} has no metadata.keys array`);
  process.exit(2);
}
console.log(`  contract: ${contractPath}`);
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
    // "inert by absence" and "inert though present" are both passes and are not
    // the same fact. `mechanism` is the first: the compiler drops it, 0 of the
    // compiled rules carry it, so the zero delta measures a field that was
    // never there. Printing them identically would let a key that QUIETLY
    // stopped being emitted look like a key that was tested.
    const how = r.absentFromArtefact
      ? `inert (absent from the compiled artefact; 0 carriers)`
      : `inert (${r.carriers} carrier(s) deleted)`;
    console.log(`  ${key.padEnd(14)} id ${String(r.idDelta).padStart(3)}  record ${String(r.recordDelta).padStart(3)}  decision ${String(r.decisionDelta).padStart(3)}  ${inert ? how : "NOT INERT"}`);
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
  console.log(`  METADATA CONTRACT OK — ${keys.length} key(s): no finding-ID, finding-record or`);
  console.log(`  decision differences observed on these ${n} cases. Bounded by this corpus; not a`);
  console.log(`  claim of universal inertness.`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
