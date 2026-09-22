#!/usr/bin/env bash
# CONTROLS for gate (e), the v-flag disclosure gate.
#
# Five READMEs, each a named shape, run against the gate in an isolated copy of
# the worker tree. Every row states the expected exit code, and the OLD gate is
# run on the SAME five so the two columns can be compared: a new green line is
# not evidence, the counterfactual is. Rows 4 and 5 are the two shapes the old
# gate passed -- a wrong published number hidden behind a correct HTML comment,
# and a second contradicting sentence after a correct one.
#
# Usage: bash controls/vflag_gate_controls.sh [old_gate_path]
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OLD="${1:-}"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
cp -R "$ROOT/src" "$WORK/src"
cp "$ROOT/README.md" "$WORK/README.md.orig"
cp "$ROOT/_vflag_disclosure_gate.mjs" "$WORK/new_gate.mjs"
[ -n "$OLD" ] && cp "$OLD" "$WORK/old_gate.mjs"

python3 - "$WORK" <<'PY'
import pathlib, sys
w = pathlib.Path(sys.argv[1])
r = (w / "README.md.orig").read_text()
assert "which 863 of 1,587 compiled entries do not" in r, "README anchor moved; controls are stale"
shapes = {
    # name                     README text                                        expected exit
    "baseline":      (r, 0),
    "wrong":         (r.replace("863 of 1,587", "862 of 1,587"), 1),
    "rephrase":      (r.replace("which 863 of", "and 862 of"), 1),
    # the correct pair in a comment the reader never sees, above a wrong published one
    "decoy_comment": ("<!-- historical: which 863 of 1,587 compiled entries do not -->\n"
                      + r.replace("863 of 1,587", "862 of 1,587"), 1),
    # the correct sentence, then a second one contradicting it
    "duplicate":     (r + "\nCurrent runtime: which 862 of 1,587 compiled entries do not "
                          "currently accept the v flag.\n", 1),
    # the claim exists ONLY inside a comment: a commented-out disclosure is none
    "only_comment":  (r.replace("which 863 of 1,587 compiled entries do not",
                                "<!-- which 863 of 1,587 compiled entries do not -->"), 1),
    # ROUND 5, the allowlist. These two must fail for DIFFERENT REASONS, and the
    # harness prints which, because "both red" would hide the whole point: one
    # is caught by COUNT without its truth ever being considered, the other by
    # MISMATCH against the measurement.
    #
    # A second sentence about the v flag, contradicting the first in wording the
    # old matcher never graded. Caught BY COUNT.
    "second_mention": (r.replace(
        "compiled entries do not\n",
        "compiled entries do not\n\nNote for operators: in practice only 400 of "
        "1,587 entries reject the v flag, so the number above is conservative.\n", 1), 1),
    # A second sentence that carries no number at all -- a hedge. Still two
    # answers, still caught BY COUNT, and nothing about it is gradeable.
    "second_mention_no_number": (r.replace(
        "compiled entries do not\n",
        "compiled entries do not\n\nIn practice the v flag limitation affects "
        "far fewer entries than that.\n", 1), 1),
    # The ONLY mention, and its pair is wrong. Caught BY MISMATCH.
    "only_mention_wrong": (r.replace("863 of 1,587", "862 of 1,587"), 1),
}
for n, (text, code) in shapes.items():
    (w / f"readme_{n}.md").write_text(text)
    (w / f"expect_{n}").write_text(str(code))
PY

run_gate () { # $1 = gate file, $2 = shape
  cp "$WORK/readme_$2.md" "$WORK/README.md"
  ( cd "$WORK" && node "$1" ) > "$WORK/$2.$(basename "$1" .mjs).log" 2>&1
  echo $?
}

printf '%-26s %-9s %-10s %-8s %s\n' SHAPE EXPECT NEW OLD 'FAILED...'
fail=0
for s in baseline wrong rephrase decoy_comment duplicate only_comment \
         second_mention second_mention_no_number only_mention_wrong; do
  want=$(cat "$WORK/expect_$s")
  got=$(run_gate "$WORK/new_gate.mjs" "$s")
  oldgot="-"
  [ -n "$OLD" ] && oldgot=$(run_gate "$WORK/old_gate.mjs" "$s")
  mark=""
  if [ "$got" != "$want" ]; then mark="  <-- NEW GATE WRONG"; fail=1; fi
  why=""
  if [ "$got" != "0" ]; then
    if grep -q "BY COUNT" "$WORK/$s.new_gate.log" 2>/dev/null; then why="by COUNT"
    elif grep -q "not the measured one" "$WORK/$s.new_gate.log" 2>/dev/null; then why="by MISMATCH"
    elif grep -q "not the canonical claim" "$WORK/$s.new_gate.log" 2>/dev/null; then why="by SHAPE"
    else why="no mention"; fi
  fi
  printf '%-26s %-9s %-10s %-8s %s%s\n' "$s" "$want" "$got" "$oldgot" "$why" "$mark"
done
echo
if [ -n "$OLD" ]; then
  echo "OLD column is the counterfactual: any row where OLD=0 and EXPECT=1 is a"
  echo "shape the old gate passed, i.e. a defect this change actually removes."
fi
exit $fail
