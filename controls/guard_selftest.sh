#!/usr/bin/env bash
# CONTROL FOR THE CONTROL: an un-mutated mutant must be REFUSED, never "inert".
#
# metadata_is_measured.mjs reports a key inert when deleting it changes nothing.
# If the mutant tree were never actually mutated, it would change nothing for a
# different reason and print exactly the same word. T10, 2026-09-21, on the same
# class from the other side: an EMPTY named root reads PROCEED while a MISSING
# one must read REFUSED, because a find over a missing directory returns zero
# files and looks exactly like a clean sandbox.
#
# So this builds the degenerate cases on purpose and requires the harness to
# refuse each one. If any row PASSES, the preconditions are not doing anything
# and a zero-delta result means nothing.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
CASES="$W/cases.json"
python3 "$ROOT/engine_parity.py" --dump-cases "$CASES" >/dev/null 2>&1 || {
  echo "could not export the corpus; cannot run the selftest"; exit 2; }

cp -R "$ROOT/src" "$W/base"; printf '{"type":"module"}' > "$W/base/package.json"

row () { # name, expected-exit-nonzero?, mutant-builder
  local name="$1" want="$2"; shift 2
  rm -rf "$W/mut_category"; "$@"
  local out; out="$(node "$ROOT/controls/_metadata_one_key.mjs" "$W" category "$CASES" 2>&1)"
  local rc=$?
  local got="refused"; [ $rc -eq 0 ] && got="accepted"
  local mark="ok"; [ "$got" != "$want" ] && { mark="  <-- GUARD DID NOT FIRE"; FAIL=1; }
  printf '%-34s want %-9s got %-9s %s\n' "$name" "$want" "$got" "$mark"
  [ "$got" = accepted ] && [ "$want" = refused ] && echo "        harness said: $(echo "$out" | head -c 150)"
  return 0
}

build_proper ()  { cp -R "$ROOT/src" "$W/mut_category"; printf '{"type":"module"}' > "$W/mut_category/package.json"
                   printf '\nfor (const p of PATTERNS) delete p.category;\n' >> "$W/mut_category/patterns.js"; }
build_unmutated (){ cp -R "$ROOT/src" "$W/mut_category"; printf '{"type":"module"}' > "$W/mut_category/package.json"; }
build_emptyrules(){ cp -R "$ROOT/src" "$W/mut_category"; printf '{"type":"module"}' > "$W/mut_category/package.json"
                    printf 'export const PATTERNS = [];\nexport const MECHANISMS = [];\n' > "$W/mut_category/patterns.js"; }
build_missing ()  { :; }   # no mutant tree at all

row_key () { # same as row(), for a key other than `category`
  local key="$1" name="$2" want="$3"; shift 3
  rm -rf "$W/mut_$key"; "$@" "$key"
  local out rc got mark
  out="$(node "$ROOT/controls/_metadata_one_key.mjs" "$W" "$key" "$CASES" 2>&1)"; rc=$?
  got="refused"; [ $rc -eq 0 ] && got="accepted"
  mark="ok"; [ "$got" != "$want" ] && { mark="  <-- GUARD DID NOT FIRE"; FAIL=1; }
  printf '%-34s want %-9s got %-9s %s\n' "$name" "$want" "$got" "$mark"
  [ "$mark" != ok ] && echo "        harness said: $(echo "$out" | head -c 200)"
  return 0
}
build_proper_key () { local k="$1"; cp -R "$ROOT/src" "$W/mut_$k"
                      printf '{"type":"module"}' > "$W/mut_$k/package.json"
                      printf '\nfor (const p of PATTERNS) delete p.%s;\n' "$k" >> "$W/mut_$k/patterns.js"; }

FAIL=0
printf '%-34s %-14s %-14s %s\n' ROW WANT GOT ''
row "a properly mutated mutant"      accepted build_proper
row "an UN-mutated mutant"           refused  build_unmutated
row "a mutant with zero rules"       refused  build_emptyrules
row "no mutant tree at all"          refused  build_missing
# THE ROW THAT WAS MISSING. The gate's only live metadata key is `mechanism`,
# which the compiler DROPS -- 0 of 1554 compiled rules carry it. The first
# version of the guard treated "absent from the base" as a broken mutant and
# would have reddened the real gate on a healthy tree. Every row above uses
# `category`, which is present on all 1554, so none of them could see it.
# A precondition tested only on the easy key is not tested.
row_key mechanism "a key the compiler legitimately drops" accepted build_proper_key

# ── EXIT CODE SEPARATION ─────────────────────────────────────────────────────
# ASTRA round 4 broke the claim these rows now defend. Exit 1 must mean A DELTA
# WAS MEASURED AND WAS NONZERO; exit 2 must mean the run never measured
# anything. He found the second half missing: with the contract present but the
# corpus exporter unreachable, the exception propagated and node exited 1, so a
# missing interpreter read as a real finding.
#
# The rows below are the ones that were absent. A run that cannot measure is
# not a detection, and nothing else in this repo says so.
echo
printf '%-34s %-14s %-14s %s\n' "EXIT-CODE ROW" WANT GOT ''
code_row () { # name, want, then the command
  local name="$1" want="$2"; shift 2
  "$@" >/dev/null 2>&1; local rc=$?
  local mark="ok"; [ "$rc" != "$want" ] && { mark="  <-- WRONG CODE"; FAIL=1; }
  printf '%-34s %-14s %-14s %s\n' "$name" "$want" "$rc" "$mark"
}
code_row "no contract argument"        2 node "$ROOT/controls/metadata_is_measured.mjs" --contract
code_row "contract path does not exist" 2 node "$ROOT/controls/metadata_is_measured.mjs" --contract /nonexistent/c.json
code_row "contract has no metadata.keys" 2 node "$ROOT/controls/metadata_is_measured.mjs" --contract "$CASES"
# THE ROW ASTRA ADDED: the contract is fine, the DEPENDENCY is not. The
# ABSOLUTE node path matters -- with a bare `node` the shell cannot find the
# interpreter either and returns 127 before any of our code runs, which tests
# the shell rather than the control. His case was node running FINE and its
# children unreachable.
NODE_BIN="$(command -v node)"
code_row "the corpus exporter is unreachable" 2 env PATH=/nonexistent "$NODE_BIN" "$ROOT/controls/metadata_is_measured.mjs"
# And the per-key child, one layer further in than the exporter.
# ASTRA round 5, X1 and X2: the FIRST filesystem touch is before the try block,
# so a bad TMPDIR threw past the handler and exited 1. Third time the untested
# route was the one I had not written; these two rows are now the enumeration.
code_row "TMPDIR does not exist"          2 env TMPDIR=/nonexistent "$NODE_BIN" "$ROOT/controls/metadata_is_measured.mjs"
code_row "TMPDIR is not a directory"      2 env TMPDIR=/dev/null    "$NODE_BIN" "$ROOT/controls/metadata_is_measured.mjs"
code_row "a real measurement still exits 0" 0 node "$ROOT/controls/metadata_is_measured.mjs"
echo
if [ "$FAIL" -ne 0 ]; then
  echo "GUARD SELFTEST FAIL — a degenerate tree was measured instead of refused."
  exit 1
fi
echo "GUARD SELFTEST OK — only a real mutation is measured; the rest are refused."
