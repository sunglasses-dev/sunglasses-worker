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

# Measured 2026-09-14 from release/v0.5.8, and identical at b4285bb / 600cb74 / main.
EXPECTED_PATTERNS_SHA256="bb79c277ac30e56eb19bd519e32264ce2ccf36e3c48cba77919168e366736ed2"

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
fi
ok "${TAG} -> ${TAG_SHA}"

echo "── 2/6 the SHARED checkout is at the tag and clean ──"
# This tree belongs to whoever is mid-ship. This script never moves it: it says
# what it needs and stops, because resetting a peer's checkout is how work is lost.
HEAD_SHA="$(git -C "$SCANNER" rev-parse HEAD)"
[ "$HEAD_SHA" = "$TAG_SHA" ] \
  || die "$SCANNER is at ${HEAD_SHA:0:8}, not ${TAG} (${TAG_SHA:0:8}).
     The compiler reads this exact path and records the ref it read.
     Whoever owns the tree right now should run:  git -C $SCANNER checkout ${TAG}"
[ -z "$(git -C "$SCANNER" status --porcelain)" ] \
  || die "$SCANNER has uncommitted changes. A build whose source cannot be named is not a build anyone can check."
ok "checkout at ${TAG}, clean"

echo "── 3/6 the tagged rule source is the one this was built against ──"
ACTUAL="$(git -C "$SCANNER" show "${TAG}:sunglasses/patterns.py" | shasum -a 256 | cut -d' ' -f1)"
[ "$ACTUAL" = "$EXPECTED_PATTERNS_SHA256" ] \
  || die "patterns.py at ${TAG} is sha256 ${ACTUAL}
     expected ${EXPECTED_PATTERNS_SHA256}
     The rule set changed between the measurement and the tag. Re-measure, re-review, do not deploy this."
ok "patterns.py sha256 matches the pin"

echo "── 4/6 recompile ──"
cd "$WORKER"
cp src/patterns.js /tmp/patterns.before.js
python3 compile_patterns.py
python3 compile_mechanisms.py
ok "compiled"

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
python3 disclosure_gate.py
python3 policy_parity.py  >/dev/null && ok "policy parity"
python3 engine_parity.py  >/dev/null && ok "engine parity"
python3 channel_parity.py >/dev/null && ok "channel parity"

cat <<'NEXT'

✅ RECOMPILE READY. Still NOT deployed.
   Deploy needs BOTH, and this script deliberately checks neither:
     1. ASTRA's GO on the exact head
     2. AZ's standing deploy path for the Worker
   Commit the recompiled src/patterns.js + src/mechanisms.js, push to PR #22,
   then deploy with wrangler per the worker deploy rule.
NEXT
