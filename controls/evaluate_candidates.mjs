// REVIEWER-SUPPLIED CANDIDATES for the worker lane, as DATA rather than code.
//
//     node controls/evaluate_candidates.mjs <candidates-dir>
//
// WHY THIS EXISTS. ASTRA's round-4 verdict returned two acceptance items as
// REFUSED rather than measured: "Constructing an additional degenerate mutant
// is REFUSED under the no-file-edit/no-new-script restrictions: supplied
// builders expose only their fixed cases", and the same for a misleading
// README. He was right and the fault is the harness's. The prompt forbids
// authoring code -- correctly, that is what the content filter cuts -- and then
// the acceptance asked him to construct things. Those cannot both hold.
//
// The channel-vocabulary lane solved this the night before by letting the
// reviewer supply JSON: authoring a JSON object is not authoring a probe. This
// is that mechanism, brought to the lane that needed it second.
//
// A candidate is one JSON object in its own file, with `name`, `expect`
// ("accept" | "refuse"), `why`, and exactly ONE of:
//
//   "mutant":  {"key": "mechanism", "drop_line": false, "empty_rules": true,
//               "no_tree": false, "reorder_ids": false, "extra_rule": false}
//        A degenerate mutant tree. `accept` means the harness MEASURES it;
//        `refuse` means the preconditions reject it. Every knob is a way a
//        mutant can be wrong without looking wrong.
//
//   "readme": "<the full README text to grade against the v-flag gate>"
//        `accept` means gate (e) passes it; `refuse` means it is caught. Use
//        this to build a README that misinforms a reader and still passes.
//
// Exit 0 when every candidate matched its `expect`; 1 when any did not. A
// mismatch is the finding: an `expect: refuse` that is accepted is a hole, an
// `expect: accept` that is refused is a false kill.
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, cpSync, rmSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const cdir = process.argv[2];
if (!cdir) { console.log("usage: evaluate_candidates.mjs <candidates-dir>"); process.exit(2); }

// `_`-prefixed files are this harness's own output. Reading its own results
// back as a candidate is a defect the channel lane shipped and then fixed; it
// does not get to happen twice.
const files = readdirSync(cdir).filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort();
// AN EMPTY CANDIDATE SET IS NOT A PASSING ONE. This exited 0 -- so a renamed
// directory, a changed extension, or the `_` filter widening by accident made
// the evaluator report SUCCESS having evaluated nothing, and an exit code is
// what a gate reads. The same shape has now been found three times in this
// codebase in one day: an FP sweep that came back clean over a rule set that
// matched nothing, a probe whose subject set was empty printing zeros, and a
// mutation battery whose verdict was `killed === mutants.length` with no
// mutants built. "I could not measure" must exit differently from "I measured
// and found nothing wrong".
if (!files.length) {
  console.log(`NO CANDIDATES in ${cdir} -- nothing was evaluated, so this is a`
    + ` harness defect and not a clean run. Check the path, the .json suffix,`
    + ` and that the files are not all '_'-prefixed harness output.`);
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), "worker-candidates-"));
let cases;
try {
  cases = join(work, "cases.json");
  execFileSync("python3", [join(root, "engine_parity.py"), "--dump-cases", cases],
    { cwd: root, stdio: "pipe" });
  cpSync(join(root, "src"), join(work, "base"), { recursive: true });
  writeFileSync(join(work, "base", "package.json"), '{"type":"module"}');
} catch (e) {
  console.log(`  could not prepare the base tree: ${e.message}`);
  console.log("  EXECUTION failure, not a measurement — exit 2.");
  rmSync(work, { recursive: true, force: true });
  process.exit(2);
}

const buildMutant = (m) => {
  const key = m.key ?? "mechanism";
  const dir = join(work, `mut_${key}`);
  rmSync(dir, { recursive: true, force: true });
  if (m.no_tree) return key;                       // deliberately absent
  cpSync(join(root, "src"), dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  const pj = join(dir, "patterns.js");
  let src = readFileSync(pj, "utf8");
  if (m.empty_rules) src = "export const PATTERNS = [];\nexport const MECHANISMS = [];\n";
  if (m.reorder_ids) src += "\nPATTERNS.reverse();\n";
  if (m.extra_rule) src += "\nPATTERNS.push({...PATTERNS[0], id: PATTERNS[0].id + '-COPY'});\n";
  if (m.drop_line !== false) src += `\nfor (const p of PATTERNS) delete p.${key};\n`;
  writeFileSync(pj, src);
  return key;
};

const gradeReadme = (text) => {
  // The gate reads src/patterns.js and README.md and nothing else, so this
  // copies those and not the repository. The first version copied `root`
  // recursively per candidate -- a 5 MB compiled pattern file and everything
  // beside it, once for every README a reviewer wants to try, which would have
  // made the probe too slow to use for the thing it exists for.
  const v = join(work, "vflag");
  rmSync(v, { recursive: true, force: true });
  mkdirSync(v, { recursive: true });
  cpSync(join(root, "src"), join(v, "src"), { recursive: true });
  cpSync(join(root, "_vflag_disclosure_gate.mjs"), join(v, "_vflag_disclosure_gate.mjs"));
  writeFileSync(join(v, "package.json"), '{"type":"module"}');
  writeFileSync(join(v, "README.md"), text);
  try {
    execFileSync("node", [join(v, "_vflag_disclosure_gate.mjs")], { cwd: v, stdio: "pipe" });
    return "accept";
  } catch { return "refuse"; }
};

let bad = 0;
const rows = [];
for (const fn of files) {
  let c;
  try { c = JSON.parse(readFileSync(join(cdir, fn), "utf8")); }
  catch (e) { console.log(`${fn}: not readable as JSON (${e.message})`); bad++; continue; }
  if (typeof c !== "object" || Array.isArray(c) || c === null) {
    console.log(`${fn}: a candidate is one JSON OBJECT`); bad++; continue;
  }
  const name = c.name ?? fn;
  if (c.expect !== "accept" && c.expect !== "refuse") {
    console.log(`${fn}: 'expect' must be "accept" or "refuse"`); bad++; continue;
  }
  let got, detail = "";
  if (c.mutant) {
    const key = buildMutant(c.mutant);
    try {
      const out = execFileSync("node", [join(here, "_metadata_one_key.mjs"), work, key, cases],
        { encoding: "utf8" });
      JSON.parse(out); got = "accept";
    } catch (e) { got = "refuse"; detail = String(e.stderr ?? e.message).split("\n").find((l) => l.includes("Error")) ?? ""; }
  } else if (typeof c.readme === "string") {
    got = gradeReadme(c.readme);
  } else {
    console.log(`${fn}: needs one of "mutant" or "readme"`); bad++; continue;
  }
  const ok = got === c.expect;
  if (!ok) bad++;
  rows.push({ name, expect: c.expect, got, matched: ok, detail });
  const verdict = ok ? "ok"
    : (c.expect === "refuse" ? "*** ACCEPTED AND SHOULD NOT BE ***" : "*** FALSE KILL ***");
  console.log(`${String(name).slice(0, 46).padEnd(48)} expect ${c.expect.padEnd(7)} got ${got.padEnd(7)} ${verdict}`);
  if (detail) console.log(`${"".padEnd(48)}   ${detail.slice(0, 120)}`);
}
writeFileSync(join(cdir, "_results.json"), JSON.stringify(rows, null, 1));
rmSync(work, { recursive: true, force: true });
console.log(`\n${rows.length} candidate(s), ${bad} not as expected`);
// Same reasoning at the other end: zero rows here means every candidate was
// dropped after the count above, which is a harness fault wearing a clean
// number -- `bad` is 0 because nothing survived to be judged.
if (!rows.length) {
  console.log(`ZERO ROWS EVALUATED despite ${files.length} candidate file(s) --`
    + ` harness defect, not a clean result.`);
  process.exit(2);
}
process.exit(bad ? 1 : 0);
