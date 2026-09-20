// GATE (e): the v-flag disclosure number, derived rather than believed.
//
// README states "<N> of <M> compiled entries do not currently accept" the `v`
// flag's set subtraction. On 2026-09-20 the 0.5.9 recompile moved M from 1,574
// to 1,587 and N from 862 to 863, and NOTHING CHECKED EITHER. The 962-of-N
// sentence had disclosure_gate.py and went red immediately; this one sat in the
// same README, one paragraph down, with no gate at all -- a fact written where
// nothing re-executes it, which is the shape that put 0.5.2 numbers on a 0.5.7
// site for twelve days.
//
// THE METHOD IS THE GATE, and it was validated before it was trusted: counting
// compiled entries whose source throws when recompiled with `u` swapped for `v`
// reproduced the README's existing 862 of 1,574 EXACTLY on the 0.5.8 artefact,
// and only then was it applied to the rebuild. A derivation that cannot
// reproduce the number already published is a different measurement wearing the
// same name.
import { readFileSync } from "node:fs";

const worker = new URL(".", import.meta.url).pathname;
const m = await import(`${worker}src/patterns.js`);

let total = 0, rejected = 0;
for (const rule of m.PATTERNS) {
  for (const entry of rule.regex ?? []) {
    total++;
    // v-mode is stricter than u-mode about escaping and class syntax; an entry
    // that throws here is one that cannot express the exclusion.
    const vflags = (entry.flags ?? "").replace("u", "") + "v";
    try { new RegExp(entry.source, vflags); } catch { rejected++; }
  }
}

const readme = readFileSync(`${worker}README.md`, "utf8");
const claim = readme.match(/which ([\d,]+) of ([\d,]+) compiled entries do not/);
const num = (s) => Number(s.replace(/,/g, ""));
const fmt = (n) => n.toLocaleString("en-US");

console.log(`  derived: ${fmt(rejected)} of ${fmt(total)} compiled entries reject the v flag`);

if (!claim) {
  console.log("  README no longer carries the 'N of M compiled entries' claim.");
  console.log("  If it was removed deliberately, remove this gate in the same commit.");
  process.exit(1);
}
const [, saidN, saidM] = claim;
console.log(`  README says: ${saidN} of ${saidM}`);
if (num(saidN) !== rejected || num(saidM) !== total) {
  console.log(`\n  V-FLAG DISCLOSURE FAIL`);
  console.log(`    README   ${saidN} of ${saidM}`);
  console.log(`    measured ${fmt(rejected)} of ${fmt(total)}`);
  console.log(`    Update the sentence to the measured pair, or explain why the`);
  console.log(`    measurement changed. Do not edit one number to match the other.`);
  process.exit(1);
}
console.log("  V-FLAG DISCLOSURE OK");
