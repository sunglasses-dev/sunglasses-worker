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
