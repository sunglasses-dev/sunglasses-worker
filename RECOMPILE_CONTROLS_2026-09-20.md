# Controls run before believing any green — v0.5.9 rehearsal, 2026-09-20

This script's whole history is printing READY when it should not: on 2026-09-14
ASTRA found, in three consecutive rounds, a checkout that could be swapped after
the precheck, three parity gates sitting on the left of an `&&` where `set -e`
does not fire, and a commit stamp compared as a PREFIX so an empty string passed.
So no green here is reported until each refusal has been seen.

## Why the recipe needed changing at all

`prep_recompile_v058.sh` step 5 asserted **the rules did not move, only the
stamp**. Correct for 0.5.8, whose `patterns.py` was byte-identical at `b4285bb`,
`600cb74`, `main` and `release/v0.5.8`. Not answerable for 0.5.9:

    patterns.py @ v0.5.8   sha256 bb79c277ac30e56eb19bd519e32264ce2ccf36e3c48cba77919168e366736ed2
    patterns.py @ v0.5.9   sha256 a4b3ee9f65e7ff9d964af87508c72c45760dcb107a3ae01a636e3c496ab6b9e5
    rules 1546 -> 1554

A pin-only edit would have run steps 1-4 and refused at step 5 **on ship day**.
Found six days early by rehearsing. "Nothing changed" cannot be asserted when
the source changed, so step 5 now asks whether the compiled set moved EXACTLY as
the tagged source moved: (a) count, (b) id set, (c) every consulted field.

## A. Gate (c) is the one that matters, and it is derived, not typed

On 2026-09-14 the port silently dropped `match_on` and `anchor_terms`, found by a
human reading the compiler. A count gate cannot see it — drop a field and the
count is unchanged.

The consulted set is derived two ways because **neither alone is complete and
each caught the other's blind spot**:

| derivation | missed | why |
|---|---|---|
| runtime recorder over every documented channel | `severity` | read at `engine.py:1046`, in a downgrade branch the probe never reached |
| static AST, scope hand-listed as engine.py | `tier` | read at `policy.py:66` — a hand-listed scope is a typed list wearing a different hat |

Scope is now **derived**: the modules that actually name `PATTERNS` /
`MECHANISM_PATTERNS`. Union, then intersected with keys that actually appear on
a pattern — without that intersection the static pass collects `descriptor_sha256`,
`hooks` and a dozen other names belonging to unrelated dicts called `p`, and the
gate goes red for the wrong reason.

Result, 10 fields: `anchor_span anchor_terms channel id keywords match_on
negation_immune regex severity tier`. Four fields are present on patterns and
consulted by nothing — `category description mechanism name` — and the compiler
may drop those freely.

**The compiled schema is not flat-identical to the Python schema.** `anchor_terms`
and `anchor_span` compile into each regex ENTRY as `anchors` / `span`, not onto
the top-level record. A naive per-field check goes RED ON A CORRECT ARTEFACT; the
mapping is explicit and checked per rule id on both sides.

## B. Source-parity controls — each gate shown red by its own stimulus

    baseline: new gate vs the KNOWN-GOOD 9-14 artefact (0.5.8)  -> PASS, 1546, all 10 fields
    drop one rule id        -> (a) compiled 1545, source has 1546                    exit 1
    RENAME one rule id      -> (a) PASSES, (b) fails: only in source GLS-AW-059      exit 1
    strip match_on          -> (a),(b) PASS; (c) 3 pairs lost, field ['match_on']    exit 1
    strip nested anchors    -> (a),(b) PASS; (c) 7 pairs lost, regex[].anchors       exit 1

The last two are the 9-14 defect exactly, and they pass (a) and (b) — which is
why a count gate could never have caught it. The rename control exists because
dropping an id is caught by (a) first, so (b) had never been red on its own.

## C. Round-7 acceptance controls (ASTRA's, 2026-09-14)

    tag does not exist                  -> REFUSED "v9.9.9 does not exist"           exit 1
    tag name disagrees with __version__ -> REFUSED, tag v0.5.9-wrongname carries
                                           __version__ 0.5.8                         exit 1
    disclosure gate forced exit 7       -> exit 1, READY lines 0
    policy parity   forced exit 7       -> exit 1, READY lines 0
    engine parity   forced exit 7       -> exit 1, READY lines 0
    channel parity  forced exit 7       -> exit 1, READY lines 0

All four gate files restored byte-identical afterwards (`git diff` empty). The
checkout-swap hole is closed structurally rather than by a check: nothing reads
the shared tree at all, both compilers and all parity scripts are bound to a
private worktree via `SG_SCANNER_ROOT` + `SUNGLASSES_SRC`.

## D. The tag-object trap, recorded because it cost a wrong number

These tags are ANNOTATED. `git rev-parse v0.5.9` returns the **tag object**
`f67db74`; the commit is `7340fce`. Both are 40-hex and both look like a sha in a
receipt. T8 handed the tag-object sha to T9 as "the sha to compile from" and
corrected it. The script never had the bug — it always dereferences `^{commit}` —
and now says so in a comment so nobody removes it.

## E. The result

    rules before 1546  after 1554     changed 0  added 8  removed 0
    added: GLS-SD-001-API GLS-SD-002-API GLS-SD-003-API GLS-SD-004-API
           GLS-SD-006-API GLS-SD-007-API GLS-SD-008-API GLS-SD-009-API
    stamp: PATTERNS_VERSION 0.5.9, COMPILED_FROM 7340fce -> resolves to 7340fceba38e
    (a) 1554 == tagged source   (b) 1554 ids identical   (c) all 10 fields survive
    anchor_span 7  anchor_terms 7  match_on 3  negation_immune 6  tier 4
    gates: disclosure OK, policy parity OK, engine parity OK, channel parity OK

## F. Disclosure numbers the recompile invalidated

The disclosure gate correctly went red first: `/about` and `README.md` said
"962 of 1,557" while the artefacts measured 1,565 (1,554 rules + 11 mechanisms).

One stale number in README is **covered by no gate at all**: "862 of 1,574
compiled entries" do not accept the `v` flag's set subtraction. Before changing
it, the measurement method was validated against the known value — counting
entries whose source throws under the `v` flag reproduced **862 of 1,574 exactly**
on the 0.5.8 artefact — and only then applied to the rebuild: **863 of 1,587**.
A number nobody can re-derive is a number that will be wrong eventually; this one
now has a method, but still no gate. Flagged rather than fixed here.

The sentence "substituting it for every boundary in 1,546 patterns ran V8 out of
heap" describes an EXPERIMENT that was performed on the 0.5.8 set. It was dated
rather than renumbered, because silently moving a historical measurement to a
current count would be inventing a result nobody ran.

---

# Gate (e) — the disclosure number nothing was checking (added same day, T9 ruling)

Section F above flagged "862 of 1,574 compiled entries" as a served claim with a
method but **no gate**. Ruled: the method IS the gate. Wired as gate (e).

The 962-of-N sentence had `disclosure_gate.py` and went red the instant 0.5.9
moved it. The v-flag sentence one paragraph down in the same README moved too
and nothing noticed. A fact written where nothing re-executes it is the shape
that left 0.5.2 numbers on a 0.5.7 site for twelve days.

## The method was validated before it was trusted

The gate script, unchanged, run against the **0.5.8 artefact and the 0.5.8
README**:

    derived: 862 of 1,574 compiled entries reject the v flag
    README says: 862 of 1,574
    V-FLAG DISCLOSURE OK

It reproduces the number that was *already published*, so it is the same
measurement rather than a different one wearing the same name. Only then was it
applied to the rebuild: **863 of 1,587**.

## Controls

    e1  numerator perturbed 863 -> 864          FAIL, names both pairs      exit 1
    e2  denominator perturbed to the stale 1,574 FAIL, names both pairs      exit 1
    e3  the claim removed from README            FAIL, and says to remove
                                                 the gate in the same commit exit 1
    e4  gate (e) forced to exit 7                script exit 1, READY lines 0
    baseline on the 0.5.8 artefact + 0.5.8 README            OK, 862 of 1,574

README restored byte-identical after e1-e3 (`git diff` empty).

The gate refuses rather than self-heals: it prints both pairs and says to update
the sentence to the measured pair, never to edit one number until they agree.

## Full run with (e) live

    ✓ disclosure gate · ✓ policy parity · ✓ engine parity · ✓ channel parity
    ✓ v-flag disclosure
    ✅ RECOMPILE READY for v0.5.9 (0.5.9 from 7340fceba38e). Still NOT deployed.

---

# ROUND 2 — ASTRA NO GO on bf6148f, three blocking findings, all adopted

## B1 — a derivation cannot be the completeness authority

ASTRA built **three real matcher reads** the derivation missed (an unusual
variable's `.get`, a comprehension subscript, a dict-unpacking copy then `.get`),
confirmed by execution that all three values are consulted, then let the ordinary
compiler drop all three. **(c) stayed green.** In the other direction, an unused
helper accessing an unrelated dict's `mechanism` key — and separately, a module
with `PATTERNS` in a **comment** — each produced a **false kill on a correct
artefact**. Dictionary spelling is not evidence of access to a pattern dictionary.

Adopted verbatim: **a reviewed contract is the authority, derivation is
diagnostic.** `pattern_field_contract.json` classifies every pattern key as
consulted (with its lowering) or metadata, and the gate **fails closed on any
source key it does not classify** — a new pattern field cannot reach the Worker
until a human decides whether it must survive. Derivation still runs and its
disagreement is *printed*, never fatal.

Proof the false-kill routes are closed by demotion rather than by patching the
heuristic — both of ASTRA's routes applied to a private 0.5.9 checkout:

    gate exit 0
    diagnostic: derivation saw 11 field(s) over 4 module(s); NOT IN CONTRACT: ['mechanism']
    ✓ (c) every contracted field preserved by value, per rule

Round 1 failed here on GLS-MER-568.

## B2 — (c) tested presence, not preservation

Six independently constructed mutants passed round 1. All six now die, each by
its own named reason:

    swap two ids, each record keeping its own data   (c) description CHANGED
    empty a nonempty regex array                     (c) regex entries 1 -> 0
    severity replaced with null                      (c) severity CHANGED
    unexpected nested anchors added                  (c) carries anchors/span,
                                                         source declares none
    existing nested anchors nulled                   (c) anchors are not the
                                                         source's anchor_terms
    a key the source does not carry                  (c) unclassified key
    (duplicate id already failed (b) in round 1)

The original four still hold: drop id → (a); rename id → (b); strip `match_on`
→ (c) 3; strip anchors → (c) 13. The unmutated artefact exits 0 — no false kill.

**Two lowerings are declared rather than loosened, both measured, both read out
of the tagged source rather than typed:**

- `keywords` — the compiler applies the engine's own FP-guard strip
  (`engine.py:468`). Compiled == source minus `SunglassesEngine.KEYWORD_DENYLIST`,
  order preserved: **1554/1554 exact** on v0.5.9. The denylist is read from the
  tagged source, so if it changes the expectation changes with it.
- `keywords: []` and `negation_immune: false` are compiler **defaults** when the
  source omits the key (766 and 1548 rules). Declared with their values, so a
  compiler that starts defaulting something else is still caught.

## B3 — the reviewed-commit check, restored

ASTRA moved `v0.5.9` onto a new unreviewed commit that still carried
`__version__ 0.5.9`. The round-1 recipe **accepted it, passed four gates and
printed READY**; the old four-pin recipe refused the same moved tag.

Making the tag an argument was right. Deleting `EXPECTED_TAG_COMMIT` with it was
not, and the boundary is the lesson: a version string, a tag name and a tree are
facts **about the source** and may be read from the checkout. *Which commit was
approved* is a fact about a **review that happened elsewhere**, and reading it
from the same checkout you are validating proves nothing.

So the sha is now a required argument. Every branch exercised by a stimulus that
actually reaches it — the first attempt reported the length check while the input
was really caught by the hex pattern:

    <none>                                     exit 2  usage
    zzzz                                       exit 1  not a hex commit id
    7340fce                                    exit 1  not a hex commit id
    7340fceb                                   exit 1  must be the FULL 40-character sha
    b7e33c23…(the moved-tag shape)             exit 1  does not name the reviewed commit
    v0.5.9 + the approved sha                  exit 0  five gates, RECOMPILE READY
