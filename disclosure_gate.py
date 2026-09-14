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
"""
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent

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
console.log(JSON.stringify({patterns: grab(p.PATTERNS), mechanisms: grab(m.MECHANISMS)}));
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
    return found


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

    if failures:
        print("DISCLOSURE GATE FAIL")
        for line in failures:
            print("  " + line)
        print(f"\n  measured: {reach} of {total} rules carry a word boundary in "
              f"a core or a guard")
        return 1

    print(f"disclosure gate clean: {reach} of {total} rules carry a word "
          f"boundary, and /about and README both say so")
    return 0


if __name__ == "__main__":
    sys.exit(main())
