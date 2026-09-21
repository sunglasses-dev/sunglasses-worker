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

// ROUND 5 VERDICT — THIS GATE IS RESCOPED, NOT FIXED. READ THIS BEFORE
// TRUSTING ITS GREEN.
//
// The allowlist below asserts ONE thing: the canonical v-flag sentence carries
// the measured pair. It does NOT establish that the README is honest about this
// quantity, and it cannot. ASTRA, 2026-09-21, constructed 32 misleading READMEs
// and **19 OF THEM PASSED**, across five independent classes:
//
//   1. STRUCTURE the splitter cannot see -- a canonical claim without its final
//      period, one newline, then a contradictory table; joined list items,
//      headings, code fences and image alt text likewise. Markdown structure is
//      not sentences.
//   2. SUBJECT wording it does not recognise -- rendered emphasis, links, HTML
//      entities, a non-breaking space.
//   3. DISTRIBUTION -- a table spreading the subject and the quantity across
//      cells so no single unit carries both.
//   4. ONE SENTENCE, TWO CLAIMS. This is the one that ends the argument: the
//      count rule counts SENTENCES, and a single grammatical sentence can carry
//      contradictory counts. "One sentence = one claim" is false in prose.
//   5. HIDDEN OR STALE canonical text -- in an outdated example or a hidden
//      element, while the visible prose contradicts it.
//
// Classes 2, 3 and 4 are not boundary problems, so no amount of better
// splitting reaches them. A sixth widening would be the fifth round of the same
// losing game: grading prose for truth cannot be won.
//
// **A README-honesty gate cannot exist. Only a this-sentence-matches-the-
// measurement gate can, and that is what this is.** Multiplicity is a NECESSARY
// check and never a SUFFICIENT one, which is why the count rule stays.
//
// ── the allowlist, within that scope ─────────────────────────────────────────
//
// Rounds 3 and 4 each widened a matcher after a new shape got past it: first an
// HTML comment, then a duplicate, then a contradiction phrased differently. That
// is the denylist game, and it is the one that cost the channel-vocabulary PR
// four rounds before it was inverted. Grading prose for truth cannot be won;
// there is always another wording.
//
// So the README may mention this subject in EXACTLY ONE sentence, and that
// sentence must be the canonical claim carrying the measured pair. A SECOND
// mention is a failure BY COUNT and is never graded for truth -- "conservative",
// "fewer than half", another N-of-M, a hedge, anything. MULTIPLICITY IS THE
// DEFECT: one quantity, one sentence, or the reader is being given two answers
// and this gate has no business deciding which one they will believe.
//
// THE SUBJECT IS THE V FLAG, NOT "compiled entries". Measured before this was
// written, because the obvious wider marker would have reddened our own README:
// three sentences mention "compiled entries" and two of them are about
// unrelated quantities (133 rules across 140 entries carrying a range; 37
// across 41 using a digit shorthand). A rule keyed on that marker fails the
// product on its first run. Keyed on the v flag, the real README has exactly
// one mention.
const SENTENCES = readme.split(/(?<=[.!?])\s+|\n\n/).filter((x) => x.trim());
const NAMES_VFLAG = /`?\bv\b`?[\s\u00a0]*flag|\bv-flag\b/i;
const mentions = SENTENCES.filter((x) => NAMES_VFLAG.test(x));

const CLAIM = /which ([\d,]+) of ([\d,]+) compiled entries do not/;
const num = (s) => Number(s.replace(/,/g, ""));
const fmt = (n) => n.toLocaleString("en-US");

console.log(`  derived: ${fmt(rejected)} of ${fmt(total)} compiled entries reject the v flag`);
console.log(`  README mentions the v flag in ${mentions.length} sentence(s)`);

if (mentions.length === 0) {
  const inComment = NAMES_VFLAG.test(readmeRaw);
  console.log("  README makes no statement about the v flag.");
  if (inComment) console.log("  It appears ONLY inside an HTML comment, which the reader never sees.");
  console.log("  If the claim was removed deliberately, remove this gate in the same commit.");
  process.exit(1);
}

if (mentions.length > 1) {
  console.log(`\n  V-FLAG DISCLOSURE FAIL — ${mentions.length} sentences mention the v flag.`);
  for (const m of mentions) console.log(`      ${m.replace(/\s+/g, " ").trim().slice(0, 150)}`);
  console.log(`    One quantity, one sentence. A second mention is a failure BY COUNT and`);
  console.log(`    is NOT graded for truth: whichever one is wrong, the reader has been`);
  console.log(`    given two answers and this gate cannot choose for them. Say it once.`);
  process.exit(1);
}

const claim = mentions[0].match(CLAIM);
if (!claim) {
  console.log(`\n  V-FLAG DISCLOSURE FAIL — the one mention is not the canonical claim:`);
  console.log(`      ${mentions[0].replace(/\s+/g, " ").trim().slice(0, 160)}`);
  console.log(`    Expected the form "which <N> of <M> compiled entries do not ...".`);
  console.log(`    A shape this gate cannot read is a shape it cannot check.`);
  process.exit(1);
}

const [, saidN, saidM] = claim;
console.log(`  README says: ${saidN} of ${saidM}`);
if (num(saidN) !== rejected || num(saidM) !== total) {
  console.log(`\n  V-FLAG DISCLOSURE FAIL — the published pair is not the measured one`);
  console.log(`    README   ${saidN} of ${saidM}`);
  console.log(`    measured ${fmt(rejected)} of ${fmt(total)}`);
  console.log(`    Update the sentence to the measured pair, or explain why the`);
  console.log(`    measurement changed. Do not edit one number to match the other.`);
  process.exit(1);
}
console.log("  V-FLAG DISCLOSURE OK (one mention, canonical, matching the measurement)");
