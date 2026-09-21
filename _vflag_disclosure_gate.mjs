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

// WHAT THE FIRST VERSION GRADED, and why that was not the disclosure.
// It used `readme.match(...)`, which returns the FIRST occurrence in the whole
// file, and then graded only that one. Two shapes walked straight through it,
// both measured on 2026-09-21 before this was written:
//
//   (1) an HTML comment carrying the correct pair, placed ABOVE a published
//       sentence carrying a wrong one -- the gate read the comment and passed a
//       README that told the reader 862;
//   (2) a second, contradicting sentence appended after the correct one -- the
//       gate read the first and never saw that the file now says both.
//
// The subject of this gate is the number a READER is given, and a reader is
// given every occurrence and none of the comments. So: comments are removed
// first (a comment can neither satisfy this gate nor break it), then EVERY
// remaining occurrence must name the measured pair, and there must be at least
// one. Two occurrences that agree are fine; the count is not the rule, the
// agreement is.
const readmeRaw = readFileSync(`${worker}README.md`, "utf8");
const readme = readmeRaw.replace(/<!--[\s\S]*?-->/g, "");
// ROUND 4, found by the reviewer-supplied candidate probe rather than by
// reading: grading only the CANONICAL WORDING leaves a contradiction in any
// other wording untouched beside it. This README passed:
//
//     ...which 863 of 1,587 compiled entries do not currently accept.
//     Note for operators: in practice only 400 of 1,587 entries reject the
//     v flag, so the number above is conservative.
//
// Both sentences are about the same quantity, the second is false, and the
// gate compared the first and stopped. ASTRA named the shape in round 4 as a
// source-derived concern; the probe turned it into an executed break.
//
// So the subject is not a phrase, it is A CLAIM ABOUT THIS QUANTITY. Every
// `N of M` pair whose surrounding sentence talks about the v flag or compiled
// entries is graded. The context window is what keeps it from grading every
// number in the file -- measured on this README, exactly one pair exists and
// it is the real claim, so the widening costs nothing here and would catch a
// second one the moment somebody adds it.
const CLAIM = /which ([\d,]+) of ([\d,]+) compiled entries do not/g;
const ANY_PAIR = /\b([\d,]+) of ([\d,]+)\b/g;
const ABOUT_VFLAG = /v.{0,3}flag|compiled entr/i;
const claims = [...readme.matchAll(CLAIM)];
const related = [...readme.matchAll(ANY_PAIR)].filter((m) => {
  const ctx = readme.slice(Math.max(0, m.index - 140), m.index + m[0].length + 140);
  return ABOUT_VFLAG.test(ctx);
});
const num = (s) => Number(s.replace(/,/g, ""));
const fmt = (n) => n.toLocaleString("en-US");

console.log(`  derived: ${fmt(rejected)} of ${fmt(total)} compiled entries reject the v flag`);

if (!claims.length) {
  const inComment = [...readmeRaw.matchAll(CLAIM)].length > 0;
  console.log("  README no longer carries the 'N of M compiled entries' claim.");
  if (inComment) {
    console.log("  It appears ONLY inside an HTML comment, which the reader never sees.");
    console.log("  A commented-out claim is not a disclosure.");
  } else {
    console.log("  If it was removed deliberately, remove this gate in the same commit.");
  }
  process.exit(1);
}

console.log(`  README says: ${claims.map(([, n, m]) => `${n} of ${m}`).join("; ")}`);
const wrong = claims.filter(([, n, m]) => num(n) !== rejected || num(m) !== total);
// The same test, over every pair the surrounding text ties to this quantity --
// including ones the canonical matcher never sees.
const wrongRelated = related.filter(([, n, m]) => num(n) !== rejected || num(m) !== total);
if (!wrong.length && wrongRelated.length) {
  console.log(`\n  V-FLAG DISCLOSURE FAIL`);
  console.log(`    the published claim agrees with the measurement, and a SECOND`);
  console.log(`    statement about the same quantity does not:`);
  for (const m of wrongRelated) {
    const ctx = readme.slice(Math.max(0, m.index - 90), m.index + m[0].length + 90);
    console.log(`      ...${ctx.replace(/\s+/g, " ").trim()}...`);
  }
  console.log(`    measured ${fmt(rejected)} of ${fmt(total)}`);
  console.log(`    A reader is given every sentence, not the one this gate grew up`);
  console.log(`    matching. Correct it or remove it.`);
  process.exit(1);
}
if (wrong.length) {
  console.log(`\n  V-FLAG DISCLOSURE FAIL`);
  for (const [, n, m] of wrong) console.log(`    README   ${n} of ${m}`);
  console.log(`    measured ${fmt(rejected)} of ${fmt(total)}`);
  if (claims.length > 1) {
    console.log(`    ${claims.length} occurrences of the claim were graded; ${wrong.length} disagree.`);
  }
  console.log(`    Update the sentence to the measured pair, or explain why the`);
  console.log(`    measurement changed. Do not edit one number to match the other.`);
  process.exit(1);
}
console.log(`  V-FLAG DISCLOSURE OK (${claims.length} occurrence(s), all agreeing)`);
