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

// ── THE SUBJECT IS THE RENDERED TEXT, and round 5 is why ────────────────────
//
// This gate's own purpose, stated above, is "the number a READER is given".
// A reader is given RENDERED markdown. So `**863**`, `&#56;63`, a non-breaking
// space, a link label, an image's alt text and a hidden `<span>` are
// PRESENTATION -- the reader sees the claim, the byte-level splitter did not.
// Ten of ASTRA's nineteen false accepts were exactly that, plus a markdown
// BLOCK boundary (a table or heading on the next line) being a boundary a
// reader sees even where there is no full stop.
//
// THIS IS A CHANGE OF SUBJECT, ONCE -- not a sixth widening of a matcher.
// Rounds 3, 4 and 5 each widened a pattern after a new wording got past it,
// which is the denylist game the channel-vocabulary PR lost four rounds to.
// Normalising to what a reader sees is not "one more shape": it is reading the
// thing the gate always said it was reading. After this, what remains
// unreachable is DECLARED (below), not chased.
//
// Measured on ASTRA's 32 candidates, preserved in controls/candidates/:
// 19 false accepts -> 9, ten fixed, ZERO honest controls broken.
const renderAsReaderSees = (s) => s
  .replace(/<!--[\s\S]*?-->/g, "")                       // comments: never shown
  .replace(/<[^>]+>/g, " ")                               // tags, hidden or not
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&nbsp;/gi, " ")
  .replace(/\u00a0/g, " ")
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")              // image -> alt text
  .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")               // link  -> label
  .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1")           // emphasis
  .replace(/`/g, "");                                     // code spans

// A markdown block opener ends the preceding unit. A table row, heading, list
// item, fence or quote on the next line is a visible break to a reader even
// when the sentence before it carries no full stop -- which is how a canonical
// claim and a contradicting table became ONE "sentence" for the old splitter.
const BLOCK_OPEN = /^\s*(\||#{1,6}\s|[-*+]\s|\d+\.\s|```|>\s)/;
const readerUnits = (text) => {
  const blocks = [];
  let cur = [];
  for (const line of text.split("\n")) {
    const opens = BLOCK_OPEN.test(line);
    if (opens || line.trim() === "") {
      if (cur.length) blocks.push(cur.join(" "));
      cur = [];
    }
    if (line.trim() !== "") cur.push(line);
    if (opens) { blocks.push(line); cur = []; }
  }
  if (cur.length) blocks.push(cur.join(" "));
  const out = [];
  for (const b of blocks)
    for (const part of b.split(/(?<=[.!?])\s+/))
      if (part.trim()) out.push(part);
  return out;
};

const readme = renderAsReaderSees(readmeRaw);

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
// ── WHAT REMAINS UNREACHABLE, DECLARED (2026-09-22) ────────────────────────
//
// Reading the RENDERED text closed ten of those nineteen. NINE REMAIN, and
// they are declared here rather than chased, because chasing them is the
// denylist game again:
//
//   19-same-sentence     ONE grammatical sentence carrying two contradictory
//                        counts. "One sentence = one claim" is false in prose,
//                        and no splitter reaches it. THIS IS THE HARD LIMIT.
//   18-table-context     subject and quantity distributed across table cells,
//   30-false-first-pair  so no single unit carries both.
//   17-reordered-words   the canonical claim reworded so the CLAIM regex,
//   20-claim-in-code     which is an allowlist of ONE form, does not match it;
//                        widening that regex is the losing game by definition.
//   06-fence-joined      a fenced block or image alt text adjacent to an
//   07-alt-joined        unpunctuated claim: reachable ONLY by rendering
//   24-inline-image      markdown properly, which is a parser, not a gate.
//   32-html-hidden-claim CSS-hidden but structurally present text: "hidden"
//                        is a rendering property this gate does not compute.
//
// WHAT I CLAIMED HERE WAS TOO STRONG, and round 6 was right to reject it.
// The line said "four of those nine are reachable by a markdown parser and
// NONE by another regex". That is a categorical impossibility assertion and I
// cannot support it: a parser supplies STRUCTURE, not prose truth, table
// semantics or CSS visibility, and those four do not form one category a
// parser alone resolves. A finite set CAN be refused by a restricted
// syntactic publishing policy without proving arbitrary prose truth.
//
// What is actually true: these nine are not reached by THIS gate's shape, and
// widening its matchers to chase them is the losing game. That is a statement
// about this gate, not about what is possible.
//
// AND DECLARING EXCEPTIONS IS NOT ENFORCING A BOUNDARY, which is the real
// finding. Round 6 authored 35 candidates and found THREE NEW FAMILIES this
// gate accepts: canonical content in unused reference definitions; literal
// code content read as active presentation; and contradictory claims across
// HTML block elements. Ten cases. Each is a rendering context the normaliser
// treats as content, so "the number a reader is given" is still not pinned
// down -- it is pinned down for the contexts I thought of.
//
// THE DIRECTION, for the Friday decision and NOT yet implemented: stop
// grading prose and ENFORCE a form. Generate the disclosure into a delimited
// block from the measurement, validate THAT block, and require the quantity to
// appear nowhere else in the rendered text -- the count rule already does the
// second half. Then the boundary is enforced by construction rather than
// declared exception by exception, and what a green means can be stated
// exactly.
//
// A green here means: the canonical sentence, AS A READER SEES IT, carries the
// measured pair, and the README mentions the v flag exactly once. It does NOT
// mean the README is honest. That distinction is the whole scope.
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
const SENTENCES = readerUnits(readme);
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
