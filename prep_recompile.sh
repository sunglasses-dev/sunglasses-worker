#!/usr/bin/env bash
# Recompile the Worker engine from a release tag.
#   ./prep_recompile.sh v0.5.9 7340fceba38ef441ae487d34dbd6889fcf60b3a5
#
# Supersedes prep_recompile_v058.sh, whose four pins were typed constants for
# one release. The tag is now an ARGUMENT and every pin is READ FROM the private
# checkout, because a constant that has to be edited per release is a constant
# that will one day be edited wrong, and the wrong value looks exactly like the
# right one.
#
# WHY THIS EXISTS. The demo sat on scanner 0.5.2 for twelve days while the site
# published 0.5.7, and nothing in the pipeline could see the gap. The rule that
# came out of that: recompile from the TAG, and prove the source is the tagged
# source before building, by SHA rather than by a pattern count. A count is a
# summary and two different rule sets can share one.
#
# ── HISTORY OF STEP 5, kept because the reason matters ────────────────────────
# The 9-14 script's step 5 asserted THE RULES DID NOT MOVE, ONLY THE STAMP, and
# died with:
#
#     "the recompile CHANGED rules, not just the stamp. That is a real engine
#      change and needs a review and an ASTRA round, not a deploy."
#
# That was correct FOR 0.5.8 and for the reason its header gave: patterns.py was
# byte-identical at b4285bb, 600cb74, main and release/v0.5.8, so a recompile
# genuinely moved only the stamp. It is not answerable for a release where the
# rule data moved. 0.5.9 is 1546 -> 1554 with a different patterns.py sha256, so
# a pin-only edit of that script would have run steps 1-4 and then REFUSED at
# step 5 -- on ship day, at the keyboard. Found 2026-09-20 by rehearsing six days
# early, which is the entire argument for rehearsing.
#
# "Nothing changed" cannot be asserted when the source changed. Step 5 now asks
# the right question instead of a weaker one: did the compiled set move EXACTLY
# as the tagged source moved, and nothing else. See _source_parity.py.
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

TAG="${1:-}"
EXPECTED_SHA="${2:-}"
[ -n "$TAG" ] && [ -n "$EXPECTED_SHA" ] || {
  echo "usage: $0 <tag> <expected-full-sha>" >&2
  echo "   e.g. $0 v0.5.9 7340fceba38ef441ae487d34dbd6889fcf60b3a5" >&2
  echo "" >&2
  echo "The sha is the commit the release was REVIEWED at, and it must come from" >&2
  echo "outside this checkout -- the release receipt, the PR, the ruling that" >&2
  echo "approved it. See the note at the identity gate below." >&2
  exit 2; }

SCANNER="${HOME}/sunglasses-dev/glasses"
WORKER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { printf '\n⛔ REFUSED: %s\n' "$1" >&2; exit 1; }
ok()  { printf '  ✓ %s\n' "$1"; }

echo "── 1/6 resolve the tag to a COMMIT ──"
git -C "$SCANNER" fetch origin --tags --quiet || true
git -C "$SCANNER" rev-parse -q --verify "refs/tags/${TAG}" >/dev/null \
  || die "${TAG} does not exist. Nothing to recompile from."
# ^{commit} IS THE POINT. These tags are ANNOTATED, so `rev-parse v0.5.9` returns
# the TAG OBJECT (f67db74), not the commit (7340fce). Both are 40-hex and both
# look like a sha in a receipt. T8 handed the tag-object sha to T9 as "the sha to
# compile from" on 2026-09-20 and corrected it; the script never had the bug
# because it always dereferenced, and it says so here so nobody removes it.
TAG_SHA="$(git -C "$SCANNER" rev-parse "refs/tags/${TAG}^{commit}")"
[ "$(git -C "$SCANNER" cat-file -t "$TAG_SHA")" = "commit" ] \
  || die "${TAG}^{commit} did not resolve to a commit object"

# ── THE IDENTITY GATE, RESTORED. ─────────────────────────────────────────────
# Making the tag an argument was right; deleting this with it was not. The 9-14
# recipe pinned EXPECTED_TAG_COMMIT, and when I replaced the four typed pins with
# "read every pin out of the private checkout" I took this one too. ASTRA showed
# the cost on 2026-09-20: he moved v0.5.9 onto a new, unreviewed commit that still
# carried __version__ 0.5.9, and the whole new recipe accepted it, passed four
# gates and printed READY. The OLD four-pin recipe refused the same moved tag
# before compiling.
#
# The lesson is the boundary, not the value: a version string, a tag name and a
# tree can all be read out of the checkout, because they are facts ABOUT the
# source. Which commit was APPROVED is not a fact about the source -- it is a
# fact about a review that happened elsewhere, and reading it from the same
# checkout you are trying to validate proves nothing at all. So it comes in as
# an argument, from the release receipt or the ruling that approved it.
case "$EXPECTED_SHA" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;;
  *) die "expected-sha '${EXPECTED_SHA}' is not a hex commit id" ;;
esac
[ "${#EXPECTED_SHA}" -eq 40 ] \
  || die "expected-sha must be the FULL 40-character sha, not an abbreviation
     (an abbreviation can become ambiguous as the repo grows; ${#EXPECTED_SHA} given)"
[ "$TAG_SHA" = "$EXPECTED_SHA" ] \
  || die "${TAG} points at ${TAG_SHA}
     approved   ${EXPECTED_SHA}
     The tag does not name the reviewed commit. Someone cut, moved or recreated
     it, and the version string would look identical either way. Re-verify the
     approval before compiling anything."
ok "${TAG} -> ${TAG_SHA} (matches the approved commit)"

echo "── 2/6 a PRIVATE checkout of the resolved commit ──"
# THE SHARED TREE IS NOT A SOURCE THIS CAN TRUST, even after checking it.
# Verifying that ~/sunglasses-dev/glasses sits at the tag and then importing from
# it later are two separate reads of a path a teammate owns; between them they
# can check out another branch mid-ship and the build would compile from whatever
# was there while this script printed the sha it verified. ASTRA demonstrated
# that hole on 2026-09-14. Nothing here reads the shared tree.
PRIVATE="$(mktemp -d /private/tmp/sg-recompile-XXXXXX)"
cleanup() { git -C "$SCANNER" worktree remove --force "$PRIVATE" >/dev/null 2>&1 || true; rm -rf "$PRIVATE"; }
trap cleanup EXIT
git -C "$SCANNER" worktree add --detach "$PRIVATE" "$TAG_SHA" >/dev/null 2>&1 \
  || die "could not create a private checkout of ${TAG_SHA}"
PRIVATE_SHA="$(git -C "$PRIVATE" rev-parse HEAD)"
[ "$PRIVATE_SHA" = "$TAG_SHA" ] || die "the private checkout is at ${PRIVATE_SHA}, not ${TAG_SHA}"
[ -z "$(git -C "$PRIVATE" status --porcelain)" ] \
  || die "the private checkout is dirty, which should be impossible and means something else is writing to it"
ok "private checkout at ${TAG_SHA:0:8}, nobody else can move it"

echo "── 3/6 read the pins OUT of the tagged source ──"
# READ, NEVER TYPED. The version this build must emit is whatever the tagged
# source says it is; a typed EXPECTED_VERSION can only ever disagree with it.
EXPECTED_VERSION="$(sed -n 's/^__version__ *= *"\([^"]*\)".*/\1/p' "${PRIVATE}/sunglasses/__init__.py")"
[ -n "$EXPECTED_VERSION" ] || die "could not read __version__ from the tagged source"
case "$TAG" in
  "v${EXPECTED_VERSION}") ;;
  *) die "tag ${TAG} carries __version__ ${EXPECTED_VERSION}; the tag name and the
     source disagree, which means the tag was cut on the wrong commit" ;;
esac
PATTERNS_SHA="$(shasum -a 256 "${PRIVATE}/sunglasses/patterns.py" | cut -d' ' -f1)"
ok "tagged source is ${EXPECTED_VERSION}, patterns.py sha256 ${PATTERNS_SHA:0:16}…"

echo "── 4/6 recompile ──"
cd "$WORKER"
cp src/patterns.js /tmp/patterns.before.js
SG_SCANNER_ROOT="$PRIVATE" python3 compile_patterns.py
SG_SCANNER_ROOT="$PRIVATE" python3 compile_mechanisms.py
ok "compiled from the private checkout"

# WHAT WAS EMITTED, not what was intended. Everything above is about inputs and
# a build can still emit something else.
EMIT_V="$(grep -o 'PATTERNS_VERSION = "[^"]*"' src/patterns.js | cut -d'"' -f2)"
EMIT_C="$(grep -o 'COMPILED_FROM = "[^"]*"' src/patterns.js | cut -d'"' -f2)"
[ "$EMIT_V" = "$EXPECTED_VERSION" ] \
  || die "the build emitted PATTERNS_VERSION ${EMIT_V}, expected ${EXPECTED_VERSION}"
# EXACT, NOT A PREFIX. This was `case "$TAG_SHA" in "${EMIT_C}"*)`, which asks
# whether the emitted stamp is a PREFIX of the expected sha. An empty stamp is a
# prefix of everything, and so is one character, so a build that emitted nothing
# passed and printed READY. ASTRA found it 2026-09-14; '' accepted, 'b' accepted.
EXPECTED_ABBREV="$(git -C "$PRIVATE" rev-parse --short HEAD)"
[ -n "$EMIT_C" ] || die "the build emitted an EMPTY COMPILED_FROM. An empty stamp names no commit."
[ -n "$EXPECTED_ABBREV" ] || die "could not read the private checkout's own abbreviation"
[ "$EMIT_C" = "$EXPECTED_ABBREV" ] \
  || die "the build emitted COMPILED_FROM ${EMIT_C}, expected exactly ${EXPECTED_ABBREV}"
RESOLVED="$(git -C "$PRIVATE" rev-parse --verify --quiet "${EMIT_C}^{commit}" || true)"
[ "$RESOLVED" = "$TAG_SHA" ] \
  || die "COMPILED_FROM ${EMIT_C} resolves to ${RESOLVED:-nothing}, not ${TAG_SHA}"
ok "emitted stamp is ${EMIT_V} from ${EMIT_C}, which resolves to ${TAG_SHA:0:12}"

echo "── 5/6 the compiled set moved EXACTLY as the tagged source moved ──"
# Replaces "the rules did not move, only the stamp" -- see the header. What the
# recompile changed relative to the previous artefact is REPORTED for the record;
# the GATE is against the tagged Python source, not against the old build.
node _compare_compiled.mjs /tmp/patterns.before.js "${WORKER}/src/patterns.js" || true
SG_SCANNER_ROOT="$PRIVATE" python3 _source_parity.py "${WORKER}/src/patterns.js" \
  || die "source parity FAILED. The compiled set is not the tagged rule set. Do not deploy this."
grep -o 'PATTERNS_VERSION = "[^"]*"\|COMPILED_FROM = "[^"]*"' src/patterns.js | sed 's/^/     /'

echo "── 6/6 gates ──"
# EACH GATE CHECKED EXPLICITLY. These were written as `cmd && ok "..."`, which
# put the gate on the LEFT of `&&`, where `set -e` deliberately does not fire, so
# all three could exit non-zero and the script printed RECOMPILE READY anyway.
# ASTRA forced exit 7 on all three and got a green run. A gate whose failure
# cannot stop the thing it gates is not a gate.
gate() {
  local name="$1"; shift
  if ! "$@" >/dev/null 2>&1; then die "${name} FAILED. Re-run it directly to see why:  $*"; fi
  ok "$name"
}
# The parity scripts resolve the scanner through SUNGLASSES_SRC, not
# SG_SCANNER_ROOT; without both they read the SHARED tree while the build came
# from the private checkout, and a green gate would describe a different engine
# than the artefact. The disclosure gate imports no Python scanner at all (it
# reads src/patterns.js and src/mechanisms.js out of this directory), per ASTRA's
# correction on d97870d, so neither variable affects it.
export SG_SCANNER_ROOT="$PRIVATE"
export SUNGLASSES_SRC="$PRIVATE"
gate "disclosure gate" python3 disclosure_gate.py
gate "policy parity"   python3 policy_parity.py
gate "engine parity"   python3 engine_parity.py
gate "channel parity"  python3 channel_parity.py
# (e) THE DISCLOSURE NUMBER NOTHING WAS CHECKING. The 962-of-N sentence has
# disclosure_gate.py and went red the moment 0.5.9 moved it. The v-flag sentence
# one paragraph down in the same README moved too -- 862 of 1,574 -> 863 of
# 1,587 -- and had no gate at all. That is a fact written where nothing
# re-executes it, which is the shape that left 0.5.2 numbers on a 0.5.7 site for
# twelve days. The method was validated before it was trusted: this same script,
# unchanged, reproduces the PUBLISHED 862 of 1,574 on the 0.5.8 artefact.
gate "v-flag disclosure" node _vflag_disclosure_gate.mjs
# (f) THE CONTRACT'S metadata BUCKET, MEASURED INSTEAD OF ASSERTED. Round 2
# wrote "consulted by nothing" over four keys and gate (c) was green for all
# four; three of them were wrong. `category` reaches control flow in the JS
# engine (engine.js:588/593, policy.js:73), and `name`/`description` are copied
# onto every finding. (c) could not see it, because (c) grades the artefact
# against the contract and the contract was the unexamined claim -- and the
# derivation could not see it either, because the derivation reads the PYTHON
# matcher while the read sites are in the Worker engine. Only running the
# compiled artefact answers it. This deletes each remaining metadata key and
# requires the engine's output to be unchanged over the parity corpus.
gate "metadata contract" node controls/metadata_is_measured.mjs

cat <<NEXT

✅ RECOMPILE READY for ${TAG} (${EXPECTED_VERSION} from ${TAG_SHA:0:12}). Still NOT deployed.
   Deploy needs BOTH, and this script deliberately checks neither:
     1. ASTRA's GO on the exact head
     2. AZ's GO on the Worker deploy path
NEXT
