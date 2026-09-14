#!/usr/bin/env bash
# Recompile the Worker engine from the v0.5.8 tag. ONE command at tag time.
#
# WHY THIS EXISTS. The demo sat on scanner 0.5.2 for twelve days while the site
# published 0.5.7, and nothing in the pipeline could see the gap. The deploy rule
# that came out of that is: recompile from the TAG, and prove the source is the
# tagged source before building, by SHA rather than by a pattern count. A count
# is a summary and two different rule sets can share one.
#
# WHAT IS ALREADY KNOWN, measured 2026-09-14 and pinned below. `sunglasses/patterns.py`
# is byte identical at b4285bb, 600cb74, origin/main and release/v0.5.8, so the
# rule DATA this build emits is already what 0.5.8 carries. What a recompile
# actually changes is the STAMP: `PATTERNS_VERSION` comes from
# `sunglasses.__version__` (0.5.7 -> 0.5.8) and `COMPILED_FROM` from the checkout
# sha. That stamp is not cosmetic. `.github/workflows/parity.yml` derives the
# scanner pin it installs from `PATTERNS_VERSION`, and `/api/about` serves it to
# visitors, so shipping 0.5.8 rules under an 0.5.7 stamp would make CI test the
# wrong engine and tell the site the wrong thing.
#
# THE ASSERTION IS THE POINT. If the tagged `patterns.py` is NOT the file this
# expectation was built against, the rule set changed between the measurement and
# the tag, and this refuses rather than quietly shipping a different engine.
set -euo pipefail

SCANNER="${HOME}/sunglasses-dev/glasses"
WORKER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAG="v0.5.8"
# REHEARSAL ONLY. The tag does not exist until main certifies the #167 squash,
# and a script first run on the night it matters is a script nobody has tested.
# `SG_REHEARSE_REF=release/v0.5.8` runs every step against the branch the tag
# will be cut from, which carries the same patterns.py and the same 0.5.8
# version. It is never a deploy path: the stamp it produces records the branch
# head, not the tag, so a rehearsal build must be thrown away.
REHEARSE="${SG_REHEARSE_REF:-}"

# Measured 2026-09-14 from release/v0.5.8, identical at b4285bb / 600cb74 / main,
# and confirmed identical at the #167 squash. ASTRA recorded the same hash as his
# reference for the tag's patterns.py, reached independently.
EXPECTED_PATTERNS_SHA256="bb79c277ac30e56eb19bd519e32264ce2ccf36e3c48cba77919168e366736ed2"

# THE COMMIT THE TAG IS SUPPOSED TO LAND ON. #167 merged as this squash and
# `b7e33c2` carries __version__ 0.5.8. Pinned because "a tag named v0.5.8
# exists" is a weaker statement than "the tag points at the commit that was
# reviewed": a tag can be cut on the wrong commit, moved, or recreated, and the
# name would look identical either way. If the tag resolves elsewhere this
# refuses rather than compiling from whatever it found.
EXPECTED_VERSION="0.5.8"
EXPECTED_TAG_COMMIT="b7e33c2393f700981125dc3c4cfad0ef36e17243"

die() { printf '\n⛔ REFUSED: %s\n' "$1" >&2; exit 1; }
ok()  { printf '  ✓ %s\n' "$1"; }

echo "── 1/6 the tag exists ──"
git -C "$SCANNER" fetch origin --tags --quiet || true
if [ -n "$REHEARSE" ]; then
  printf '  ⚠ REHEARSAL against %s. The build this produces must be discarded.\n' "$REHEARSE"
  TAG="$REHEARSE"
  TAG_SHA="$(git -C "$SCANNER" rev-parse "${REHEARSE}^{commit}")" || die "no such ref ${REHEARSE}"
else
  git -C "$SCANNER" rev-parse -q --verify "refs/tags/${TAG}" >/dev/null \
    || die "${TAG} does not exist yet. It lands after main certifies the #167 squash. Nothing to deploy until then."
  TAG_SHA="$(git -C "$SCANNER" rev-parse "refs/tags/${TAG}^{commit}")"
  [ "$TAG_SHA" = "$EXPECTED_TAG_COMMIT" ] \
    || die "${TAG} points at ${TAG_SHA}
     expected ${EXPECTED_TAG_COMMIT} (the #167 squash)
     The tag is not on the commit this was prepared against. Someone cut, moved or recreated it. Re-verify before deploying anything."
fi
ok "${TAG} -> ${TAG_SHA}"

echo "── 2/6 a PRIVATE checkout of the resolved commit ──"
# THE SHARED TREE IS NOT A SOURCE THIS CAN TRUST, even after checking it.
# Verifying that ~/sunglasses-dev/glasses sits at the tag and then importing
# from it later are two separate reads of a path a teammate owns. Between them
# they can check out another branch mid-ship, and the build would compile from
# whatever was there while this script still printed the sha it verified. That
# is a time-of-check to time-of-use hole and ASTRA demonstrated it.
#
# So nothing here reads the shared tree. A private worktree is created at the
# resolved commit, both compilers are bound to it through SG_SCANNER_ROOT, and
# it is removed on exit. Nobody else can move it.
PRIVATE="$(mktemp -d /private/tmp/sg-recompile-XXXXXX)"
cleanup() { git -C "$SCANNER" worktree remove --force "$PRIVATE" >/dev/null 2>&1 || true; rm -rf "$PRIVATE"; }
trap cleanup EXIT
git -C "$SCANNER" worktree add --detach "$PRIVATE" "$TAG_SHA" >/dev/null 2>&1 \
  || die "could not create a private checkout of ${TAG_SHA} from ${SCANNER}"
PRIVATE_SHA="$(git -C "$PRIVATE" rev-parse HEAD)"
[ "$PRIVATE_SHA" = "$TAG_SHA" ] \
  || die "the private checkout is at ${PRIVATE_SHA}, not ${TAG_SHA}"
[ -z "$(git -C "$PRIVATE" status --porcelain)" ] \
  || die "the private checkout is dirty, which should be impossible and means something else is writing to it"
ok "private checkout at ${TAG_SHA:0:8}, nobody else can move it"

echo "── 3/6 the tagged rule source is the one this was built against ──"
ACTUAL="$(shasum -a 256 "${PRIVATE}/sunglasses/patterns.py" | cut -d' ' -f1)"
[ "$ACTUAL" = "$EXPECTED_PATTERNS_SHA256" ] \
  || die "patterns.py at ${TAG} is sha256 ${ACTUAL}
     expected ${EXPECTED_PATTERNS_SHA256}
     The rule set changed between the measurement and the tag. Re-measure, re-review, do not deploy this."
ok "patterns.py sha256 matches the pin"

echo "── 4/6 recompile ──"
cd "$WORKER"
cp src/patterns.js /tmp/patterns.before.js
SG_SCANNER_ROOT="$PRIVATE" python3 compile_patterns.py
SG_SCANNER_ROOT="$PRIVATE" python3 compile_mechanisms.py
ok "compiled from the private checkout"

# WHAT WAS EMITTED, not what was intended. The stamp is read back out of the
# artifact, because every check above this line is about inputs and a build can
# still emit something else.
EMIT_V="$(grep -o 'PATTERNS_VERSION = "[^"]*"' src/patterns.js | cut -d'"' -f2)"
EMIT_C="$(grep -o 'COMPILED_FROM = "[^"]*"' src/patterns.js | cut -d'"' -f2)"
[ "$EMIT_V" = "$EXPECTED_VERSION" ] \
  || die "the build emitted PATTERNS_VERSION ${EMIT_V}, expected ${EXPECTED_VERSION}"
# EXACT, NOT A PREFIX. This was `case "$TAG_SHA" in "${EMIT_C}"*)`, which asks
# whether the emitted stamp is a PREFIX of the expected sha. An empty stamp is a
# prefix of everything, and so is a single character, so a build that emitted
# nothing at all passed and printed READY. ASTRA found it; reproduced before the
# fix: '' accepted, 'b' accepted.
#
# Recognising a resemblance is not recognising the value. The stamp now has to
# equal the abbreviation the PRIVATE checkout produces for itself, be non-empty,
# and resolve back through git to exactly TAG_SHA. Three conditions because the
# first two are about the string and the third is about what it names.
EXPECTED_ABBREV="$(git -C "$PRIVATE" rev-parse --short HEAD)"
[ -n "$EMIT_C" ] \
  || die "the build emitted an EMPTY COMPILED_FROM. An empty stamp names no commit."
[ -n "$EXPECTED_ABBREV" ] \
  || die "could not read the private checkout's own abbreviation, so there is nothing to compare against"
[ "$EMIT_C" = "$EXPECTED_ABBREV" ] \
  || die "the build emitted COMPILED_FROM ${EMIT_C}, expected exactly ${EXPECTED_ABBREV}"
RESOLVED="$(git -C "$PRIVATE" rev-parse --verify --quiet "${EMIT_C}^{commit}" || true)"
[ "$RESOLVED" = "$TAG_SHA" ] \
  || die "COMPILED_FROM ${EMIT_C} resolves to ${RESOLVED:-nothing}, not ${TAG_SHA}"
ok "emitted stamp is ${EMIT_V} from ${EMIT_C}, which resolves to ${TAG_SHA:0:12}"

echo "── 5/6 the RULES did not move, only the stamp ──"
# Compared semantically, not as text. PATTERNS is one enormous line, so a text
# diff reports the whole array on any change, and the compiler's anchor
# extraction is order unstable: rebuilding identical sources permutes a few
# `anchors` arrays. ASTRA saw the same thing ("zero compiled-record differences
# after canonicalizing anchor order"). Measured 2026-09-14 rehearsing this script
# against release/v0.5.8: 7 rules permuted, 0 changed, 0 added, 0 removed.
if ! node _compare_compiled.mjs /tmp/patterns.before.js "${WORKER}/src/patterns.js"; then
  die "the recompile CHANGED rules, not just the stamp. That is a real engine change and needs a review and an ASTRA round, not a deploy."
fi
ok "rule set identical; stamp and anchor order moved"
grep -o 'PATTERNS_VERSION = "[^"]*"\|COMPILED_FROM = "[^"]*"' src/patterns.js | sed 's/^/     /'

echo "── 6/6 gates ──"
# EACH GATE CHECKED EXPLICITLY. These were written as `cmd && ok "..."`, which
# put the gate on the LEFT of `&&`. `set -e` deliberately ignores a failure
# there, because that position is a tested context, so all three could exit
# non-zero and the script printed RECOMPILE READY anyway. ASTRA forced exit 7 on
# all three and got a green run; reproduced here before it was fixed. A gate
# whose failure cannot stop the thing it gates is not a gate.
gate() {
  local name="$1"; shift
  if ! "$@" >/dev/null 2>&1; then
    die "${name} FAILED. Re-run it directly to see why:  $*"
  fi
  ok "$name"
}
# THE GATES MUST READ THE ENGINE THE BUILD READ. The parity scripts resolve the
# scanner through SUNGLASSES_SRC, not SG_SCANNER_ROOT, so without this they
# imported the SHARED tree while the build came from the private checkout, and a
# green gate would have described a different engine than the artifact. Both
# names are exported because the compilers and the gates read different ones.
export SG_SCANNER_ROOT="$PRIVATE"
export SUNGLASSES_SRC="$PRIVATE"
gate "disclosure gate" python3 disclosure_gate.py
gate "policy parity"   python3 policy_parity.py
gate "engine parity"   python3 engine_parity.py
gate "channel parity"  python3 channel_parity.py

cat <<'NEXT'

✅ RECOMPILE READY. Still NOT deployed.
   Deploy needs BOTH, and this script deliberately checks neither:
     1. ASTRA's GO on the exact head
     2. AZ's standing deploy path for the Worker
   Commit the recompiled src/patterns.js + src/mechanisms.js, push to PR #22,
   then deploy with wrangler per the worker deploy rule.
NEXT
