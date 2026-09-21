// One key, one process. argv: <workdir> <key> <cases.json>. Prints JSON.
import { readFileSync } from "node:fs";
import { join } from "node:path";
const [work, key, casesPath] = process.argv.slice(2);
let absentFromArtefact = false;
const cases = JSON.parse(readFileSync(casesPath, "utf8"));
if (!cases.length) throw new Error("the corpus is empty; zero deltas would mean nothing");
const b = await import(`file://${join(work, "base", "engine.js")}`);
const m = await import(`file://${join(work, `mut_${key}`, "engine.js")}`);

// EMPTY IS NOT THE SAME AS INERT, and in this harness they print identically.
// If the mutant tree had failed to copy, or the deletion line had not been
// appended, every comparison below would find zero differences and the gate
// would report METADATA CONTRACT OK -- a confident green produced by there
// being nothing to compare. T10 hit the same class tonight from the other side
// (an EMPTY named root reads PROCEED, a MISSING one must read REFUSED; a find
// over a missing directory returns zero files and looks exactly like a clean
// sandbox). So the preconditions are asserted before any delta is believed.
const mutSrc = readFileSync(join(work, `mut_${key}`, "patterns.js"), "utf8");
if (!mutSrc.includes(`delete p.${key};`)) {
  throw new Error(`mut_${key}/patterns.js does not carry the deletion line; `
    + `a mutant that was never mutated measures 0 deltas and reads as inert`);
}
// engine.js exports scan/STATS/VALID_CHANNELS and NOT the rule array -- the
// first version of this guard read `b.PATTERNS`, got undefined, and would have
// thrown on every correct run. A precondition check that fires on a healthy
// tree is worse than none, so the rules come from patterns.js, which is where
// they are actually exported from.
const bp = await import(`file://${join(work, "base", "patterns.js")}`);
const mp = await import(`file://${join(work, `mut_${key}`, "patterns.js")}`);
const nBase = bp.PATTERNS?.length ?? 0, nMut = mp.PATTERNS?.length ?? 0;
if (!nBase || !nMut) {
  throw new Error(`rule counts base=${nBase} mutant=${nMut}; an engine that loaded `
    + `no rules finds nothing and agrees with everything`);
}
if (nBase !== nMut) {
  throw new Error(`rule counts differ, base=${nBase} mutant=${nMut}; the mutation `
    + `should delete a FIELD, not a rule`);
}
// The field really is gone from the mutant -- and ABSENT FROM THE BASE IS A
// LEGITIMATE ANSWER, not a broken mutant. `mechanism` is the live example: the
// contract's whole claim about it is that the compiler DROPS it, and 0 of 1554
// compiled rules carry it, so deleting it is a no-op and that no-op is the
// correct result. The first version of this guard threw on exactly that and
// would have reddened the real gate on a healthy tree -- caught because the
// selftest used `category`, which IS present, while the gate runs `mechanism`,
// which is not. A precondition tested only on the easy key is not tested.
const carriers = (bp.PATTERNS ?? []).filter((p) => key in p).length;
const survivors = (mp.PATTERNS ?? []).filter((p) => key in p).length;
if (carriers === 0) {
  // Inert by absence. Say so, so nobody reads a zero delta as a measurement of
  // a field that was there.
  absentFromArtefact = true;
} else if (survivors !== 0) {
  throw new Error(`\`${key}\` survives on ${survivors} rule(s) in the mutant; `
    + `the delete did not take, so a zero delta would mean nothing`);
}
let idDelta = 0, recordDelta = 0, decisionDelta = 0;
const examples = [];
for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  const x = b.scan(c.text, c.channel), y = m.scan(c.text, c.channel);
  const ids = (r) => r.findings.map((f) => f.id).sort();
  if (JSON.stringify(ids(x)) !== JSON.stringify(ids(y))) {
    idDelta++;
    if (examples.length < 3) examples.push({ case: c.name ?? i, added: ids(y).filter((z) => !ids(x).includes(z)), removed: ids(x).filter((z) => !ids(y).includes(z)) });
  }
  if (JSON.stringify(x.findings) !== JSON.stringify(y.findings)) recordDelta++;
  if (x.decision !== y.decision) decisionDelta++;
}
process.stdout.write(JSON.stringify({ key, cases: cases.length, idDelta, recordDelta,
                                      decisionDelta, examples, carriers, absentFromArtefact }));
