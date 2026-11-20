#!/usr/bin/env python3
"""The disclosed word-boundary reach must equal the compiled artifact's.

WHY THIS GATE EXISTS. `/about` and the README advertised "924 of 1,557" for
months. The denominator was right, 1,546 patterns plus 11 mechanisms. The
numerator was produced by a counter that read each rule's core `regex[].source`
and never walked the `guards` array, and `compile_patterns.py` splits every
lookahead-led or caret-led predicate into a core plus guards. 38 rules carry
their boundary only inside a guard. 913 cores plus 11 mechanisms is exactly the
924 that shipped, which is how the undercount was traced.

A disclosure that nothing measures drifts the moment the compiler changes shape,
and this one drifted in the direction that UNDERSTATES a limitation. So the
number is derived from the compiled artifacts on every run and compared against
the strings that actually ship. Growing the pattern set is expected to change
it; the gate fails, and the fix is to update the two strings in the same commit.

Counts word boundaries the way a regex engine does: a `\\b` inside a character
class is a backspace, and a `\\\\b` is an escaped literal backslash followed by b.

THE CHARACTER CLASS BRANCH IS DEFENSIVE AND CURRENTLY UNEXERCISED. Zero of the
2,277 compiled regex sources put a `\\b` inside a class, so removing that branch
does not change today's count and this gate would not notice. It is kept because
the corpus grows and a backspace counted as a boundary would inflate a
disclosure, but nobody should read a green run as evidence that it works.

THE WORD CLASS ENTRY OF THE LIST IS RECOUNTED THE SAME WAY. /about prints how many rules hold the compiled word class and in
how many regex cores (patterns and mechanisms, in total and apart). The gate counts the cores that carry the class from the
compiled artifacts, reads the six printed numbers out of the string, and fails when any one differs.

THE WORD CLASS SWEEP. The class the compiler writes for \\w is read with the flags a compiled rule carries (i and u) over every scalar
value and set beside Python's \\w, on the one Python whose Unicode version is the one the tables are pinned to (a Python on another
version has another \\w and the sweep says it was not run). A character Python's \\w holds and the class does not (MISSING) must be none.
The class may hold more characters, because case folding follows the runtime and folds a few characters onto letters (EXTRA), and the
number moves with the Unicode version of the runtime, so the gate holds it to a small range and does not pin it.
"""
import json
import pathlib
import unicodedata
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent
# The word class compile_patterns.py writes in place of \\w (its WORD_CLASS), inside a class.
WORD_CLASS = "\\p{L}\\p{N}_"
# Opens both EDGE_BOUNDARY and EDGE_NON_BOUNDARY in compile_patterns.py.
EDGE_OPEN = "(?<=[\\w\u0130\u0131\\u0080-\\u{10FFFF}])"

DUMP = """
const p = await import("%s/src/patterns.js");
const m = await import("%s/src/mechanisms.js");
const grab = (rules) => rules.map((r) => {
  const out = [];
  for (const rx of (r.regex || [])) {
    if (rx.source) out.push(rx.source);
    for (const g of (rx.guards || [])) if (g.source) out.push(g.source);
    for (const a of (rx.anchors || [])) if (a.source) out.push(a.source);
  }
  return out;
});
const cores = (rules) => rules.map((r) => (r.regex || []).map((rx) => rx.source || ""));
console.log(JSON.stringify({patterns: grab(p.PATTERNS), mechanisms: grab(m.MECHANISMS),
                            pattern_cores: cores(p.PATTERNS), mechanism_cores: cores(m.MECHANISMS)}));
"""


def word_boundaries(source: str) -> int:
    """True word boundaries only: not inside a class, not an escaped literal."""
    i, n, in_class, found = 0, len(source), False, 0
    while i < n:
        char = source[i]
        if char == "\\":
            if i + 1 < n and source[i + 1] == "b" and not in_class:
                found += 1
            i += 2
            continue
        if char == "[" and not in_class:
            in_class = True
            i += 1
            if i < n and source[i] == "^":
                i += 1
            if i < n and source[i] == "]":
                i += 1
            continue
        if char == "]" and in_class:
            in_class = False
        i += 1
    # The compiler writes a boundary as a lookaround pair over the edge class
    # (compile_patterns.EDGE_BOUNDARY), so after it a rule carries no `\\b` at
    # all. Its reach is unchanged and is still what the disclosure states, so
    # the lookbehind that opens either form is counted as one boundary.
    found += source.count(EDGE_OPEN)
    return found


SWEEP = """
import { pinRx, PINNED_UNICODE } from "%s/src/pinned.js";
const wide = pinRx("[\\\\p{L}\\\\p{N}_]", "iu");
let bits = "";
for (let c = 0; c <= 0x10ffff; c++) {
  if (c >= 0xd800 && c <= 0xdfff) continue;
  bits += wide.test(String.fromCodePoint(c)) ? "1" : "0";
}
console.log(JSON.stringify({pinned: PINNED_UNICODE, runtime: process.versions.unicode, bits}));
"""
EXTRA_RANGE = (1, 16)


def word_class_sweep():
    """(pinned version, runtime version, extra, missing), or None when this Python's Unicode is not the pinned one."""
    script = ROOT / "_disclosure_sweep.mjs"
    script.write_text(SWEEP % ROOT)
    try:
        raw = subprocess.run(["node", str(script)], capture_output=True, text=True, check=True).stdout
    finally:
        script.unlink(missing_ok=True)
    data = json.loads(raw)
    if unicodedata.unidata_version != data["pinned"]:
        return None
    word = re.compile(r"\w", re.I)
    extra = missing = at = 0
    for code in range(0x110000):
        if 0xD800 <= code <= 0xDFFF:
            continue
        held = word.fullmatch(chr(code)) is not None
        wide = data["bits"][at] == "1"
        at += 1
        extra += wide and not held
        missing += held and not wide
    return data["pinned"], data["runtime"], extra, missing


def wc_pinned():
    return re.search(r'PINNED_UNICODE = "([^"]+)"', (ROOT / "src" / "unicode_tables.js").read_text()).group(1)


def word_class_reach(cores):
    """(rules, entries): the rules with a regex core that holds the word class, and those cores. A core is one entry
    of a rule's regex list, as the compiler writes it; a guard or an anchor is not a core."""
    rules = entries = 0
    for rule in cores:
        held = sum(1 for source in rule if WORD_CLASS in source)
        if held:
            rules += 1
            entries += held
    return rules, entries


def _number(text):
    return int(text.replace(",", ""))


def main() -> int:
    script = ROOT / "_disclosure_dump.mjs"
    script.write_text(DUMP % (ROOT, ROOT))
    try:
        raw = subprocess.run([("node"), str(script)], capture_output=True,
                             text=True, check=True).stdout
    finally:
        script.unlink(missing_ok=True)
    data = json.loads(raw)

    rules = data["patterns"] + data["mechanisms"]
    total = len(rules)
    reach = sum(1 for sources in rules
                if any(word_boundaries(s) for s in sources))
    # The same count in its two parts, so a printed number that mixes them up shows where it went wrong.
    reach_patterns = sum(1 for sources in data["patterns"] if any(word_boundaries(s) for s in sources))
    reach_mechanisms = reach - reach_patterns
    split = "%d of %d pattern rules plus %d of %d mechanism rules" % (
        reach_patterns, len(data["patterns"]), reach_mechanisms, len(data["mechanisms"]))

    # The strings that actually ship, read rather than restated.
    about = (ROOT / "src" / "preprocessor.js").read_text()
    readme = (ROOT / "README.md").read_text()

    failures = []
    claim = re.search(
        r"(\d[\d,]*) of ([\d,]*\d) rules use a word boundary in a core or a guard",
        about)
    if not claim:
        failures.append("src/preprocessor.js no longer states the boundary reach "
                        "in the form this gate reads. A disclosure this gate "
                        "cannot find is a disclosure it cannot check.")
    else:
        stated_reach = int(claim.group(1).replace(",", ""))
        stated_total = int(claim.group(2).replace(",", ""))
        if (stated_reach, stated_total) != (reach, total):
            failures.append(
                f"/about says {stated_reach} of {stated_total}; the compiled "
                f"artifacts say {reach} of {total}")

    readme_claim = re.search(
        r"(\d[\d,]*) of the ([\d,]*\d) shipped\s+rules contain a boundary", readme)
    if not readme_claim:
        failures.append("README.md no longer states the boundary reach in the "
                        "form this gate reads.")
    else:
        stated_reach = int(readme_claim.group(1).replace(",", ""))
        stated_total = int(readme_claim.group(2).replace(",", ""))
        if (stated_reach, stated_total) != (reach, total):
            failures.append(
                f"README.md says {stated_reach} of {stated_total}; the compiled "
                f"artifacts say {reach} of {total}")

    # The word class entry of the list: its counts are read out of the printed string, never restated here.
    wc_rules, wc_entries = word_class_reach(data["pattern_cores"])
    wc_mech_rules, wc_mech_entries = word_class_reach(data["mechanism_cores"])
    wc_measured = (wc_rules + wc_mech_rules, wc_entries + wc_mech_entries,
                   wc_rules, wc_entries, wc_mech_rules, wc_mech_entries)
    wc_claim = re.search(
        r"Reach is (\d[\d,]*) rules across (\d[\d,]*) compiled entries, being (\d[\d,]*) rules in "
        r"(\d[\d,]*) entries plus (\d[\d,]*) mechanism rules in (\d[\d,]*) entries", about)
    if not wc_claim:
        failures.append("src/preprocessor.js no longer states the word class reach in the form this gate reads. "
                        "A disclosure this gate cannot find is a disclosure it cannot check.")
    else:
        wc_stated = tuple(_number(group) for group in wc_claim.groups())
        if wc_stated != wc_measured:
            failures.append(
                "/about word class says %d rules across %d entries, being %d in %d plus %d mechanism rules in %d; "
                "the compiled artifacts say %d across %d, being %d in %d plus %d in %d"
                % (wc_stated + wc_measured))

    sweep = word_class_sweep()
    if sweep is None:
        sweep_line = "word class sweep not run (this Python's Unicode is not the pinned %s)" % wc_pinned()
    else:
        pinned, runtime, extra, missing = sweep
        sweep_line = ("word class sweep on Unicode %s tables, runtime Unicode %s: %d extra, %d missing" % (pinned, runtime, extra, missing))
        if missing:
            failures.append("the compiled word class lacks %d characters Python's \\w holds" % missing)
        if not EXTRA_RANGE[0] <= extra <= EXTRA_RANGE[1]:
            failures.append("the compiled word class holds %d characters Python's \\w does not, outside %d to %d"
                            % ((extra,) + EXTRA_RANGE))

    if failures:
        print("DISCLOSURE GATE FAIL")
        for line in failures:
            print("  " + line)
        print(f"\n  measured: {reach} of {total} rules carry a word boundary in "
              f"a core or a guard ({split}); {wc_measured[0]} rules across {wc_measured[1]} entries hold the word class; {sweep_line}")
        return 1

    print(f"disclosure gate clean: {reach} of {total} rules carry a word "
          f"boundary ({split}), and /about and README both say so; {wc_measured[0]} rules across {wc_measured[1]} entries "
          f"hold the word class, and /about says so; {sweep_line}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
