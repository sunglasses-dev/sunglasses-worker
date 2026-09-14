# Sunglasses Worker — hosted scan demo

Zero-install demo of the Sunglasses AI-agent input scanner, running on Cloudflare Workers.
The **pip package stays the product of record**; this is a try-before-install front door
(and the "core infra on Workers" that Workers Launchpad eligibility asks for).

**Status: demo build. Differentially tested against the pip scanner by the gates
below, which is not the same as parity: the deltas section lists what is still
different and why, and ASTRA's independent review of 2026-09-13 found four of
them that these gates did not. Hosted demo: https://sunglasses.dev/api/ (same-origin mount of this Worker; `/scan` is Turnstile-gated). `pip install sunglasses` remains the product of record.**

## What it is
- `GET /` — paste-and-scan page (dark kit, sample chips, no tracking)
- `POST /scan` `{text, channel?}` → `{decision, findings[], channel, latency_ms}`
- `GET /about` — engine stats + honest list of deltas vs the pip scanner

## Privacy posture (the trust line)
Payloads are scanned in request memory and discarded. No KV, no D1, no R2, no analytics
engine, no tail consumers, no cookies. `wrangler.toml` has no storage bindings — that's
the enforcement, not just the promise.

## How it was built (and how to trust it)
`compile_patterns.py` reads the **live scanner package** (`~/sunglasses-dev/glasses`,
v0.5.2) and emits `src/patterns.js`. Nothing is hand-copied. Then four gates run:

| Gate | What it proves | Result (measured 2026-09-01, scanner v0.5.2) |
|---|---|---|
| `compile_patterns.py` | every regex converts + compiles in V8 | **1437/1437 ported, 0 failed** |
| `parity_test.py` | each converted regex matches the same strings as Python (generated positives + benign corpus) | **820 regexes/run, 0 misses · 11,672 benign checks, 0 disagreements** |
| `engine_parity.py` | end-to-end verdict parity on attack canaries, negation cases, clean files, the full benchmark + FP corpora | **136 cases, 0 verdict splits, 0 finding-set deltas** |
| `policy_parity.py` | the repo-scan rollup ladder agrees py-vs-js | **14 cases, 0 mismatches** |
| `wide_parity.py` | 311 corpus cases (harvested from the scanner's own test suite) × 5 channels | **1,555 pairs, 0 verdict splits, 0 finding-set deltas** |
| `workerd_probe.py` | the three questions only the SERVING runtime can answer — modifier-group regexes construct, unknown channel fails closed, alias channel resolves | **3/3 in `wrangler dev --local`** |

`parity_test.py` generates its positive samples randomly (exrex), so the regex count moves
run to run — that randomness is what keeps finding new conversion holes. It prints its seed
every run; replay a failure with `PARITY_SEED=<seed> python3 parity_test.py`.

Re-run all of it: `python3 compile_patterns.py && python3 parity_test.py && python3 engine_parity.py && python3 policy_parity.py && python3 wide_parity.py`

## Honest deltas vs the pip scanner
- **`match_on: "normalized"` and `anchor_terms` — CLOSED 2026-09-13**, both
  ported, both proven by the differential rather than by inspection. They are
  recorded here rather than deleted because the gap was real and shipped: for
  twelve days this port evaluated `GLS-PI-INFO-API`, `GLS-PIEMN-001-API` and
  `GLS-PI-016-API` on raw text only, while the pip scanner also reads the
  normalized view for them, and it had no anchored lane at all for the seven
  rules that declare a rare token. `wide_parity` now reports 0 verdict splits
  and 0 finding-set deltas over 1,555 case-channel pairs; before the port it
  reported 2 deltas and still printed PASS, which is fixed separately.

- **Slow input class on the live demo, OPEN on the deployed worker only.** The
  bounded search that main added for the 27 KB long word document in scanner PR
  #157 is now ported here, and that document completes in 0.107 s on message and
  0.183 s on file with the pip scanner's decision preserved. It is NOT in the
  worker running at sunglasses.dev, which serves patterns 0.5.2, so the public
  demo still has that slow input class until this branch is deployed. What
  bounds it there is the Workers CPU limit and the 30 scans per minute per IP
  cap, nothing in the engine.

- **Word boundaries, OPEN and bounded.** `\w` is now written as
  `[\p{L}\p{N}_]`, chosen by enumerating every Unicode scalar. That is Python's
  class as a FORM and not as a membership: under the real flags it admits 4,658
  code points Python's does not, and the difference runs in both directions on
  U+0345. The bullet below states it. This sentence used to say `\w` simply was
  Python's own class, which asserted an equality the enumeration disproves.

  `\b` is still ASCII: the faithful rewrite is a pair of lookarounds over that
  class, and substituting it for every boundary in 1,546 patterns ran V8's regex compiler
  out of heap before a single document was scanned. 962 of the 1,557 shipped
  rules contain a boundary in a core or a guard, which is the number of rules
  this can reach rather than the number it changes. The earlier 924 counted
  core regex sources only and missed 38 rules whose boundary sits inside a
  split-out guard, and guards execute like any other matcher.

- **One word-class difference, OPEN and exactly one character, in BOTH
  directions.** Under the real flags the emitted class admits 4,658 code points
  Python's `\w` does not, and 4,657 of those are Unicode version skew. The
  remaining one is U+0345, an already assigned combining character that
  case-insensitive matching folds into the class. Expressing the exclusion needs
  the `v` flag's set subtraction, which 862 of 1,574 compiled entries do not
  currently accept, so this is constrained and disclosed rather than repaired.

  It does NOT only over-match, and the earlier wording here said it did. The
  positive class matches U+0345 where Python's `\w` does not, which can add a
  finding. The NEGATED class fails to match it where Python's `\W` does, which
  can drop one. Measured directly under `iu` in both directions. A miss is the
  dangerous half and the old sentence hid it.

- **UTF-16 offsets, OPEN.** The `u` flag makes matching step by code point; it
  does not change JavaScript string lengths or indices. Windowed matching,
  anchored windows, negation ranges, corroboration and excerpts still measure in
  UTF-16 units where Python measures in code points, so their boundaries can
  differ around astral characters.

- **Unicode version skew, OPEN and not closable here.** 28 case-fold mappings
  and 4,657 word characters differ between this runtime and the pip scanner's
  Python, every one of them assigned in the newer Unicode. Measured by sweeping
  all 1,112,064 scalars. Neither engine is wrong.

- **HTML entities, NARROWED, and one regression found by review.** Numeric
  references match Python across the ordinary and invalid codepoint range,
  including the form with no closing semicolon, with the invalid codepoint tables
  extracted from the interpreter. ONE numeric case is still open and is not a
  named-set problem: a reference of several hundred digits overflows and stays
  encoded here where Python returns U+FFFD. This paragraph previously said the
  numeric form matched Python outright, which was false for that input.

  The named set is still the common subset rather than the full HTML5 one.

  The rewrite that added the numeric form BROKE the named one: the table is keyed
  without the terminating semicolon, so matching the stem and re-appending what
  followed turned every ordinary `&quot;` into a quote followed by a semicolon.
  ASTRA measured 100 documents across 2 channels, 200 block-to-allow pairs on the
  six API siblings, from one character. Our own gates did not catch it; his
  corpus did.

- **Percent decoding, NARROWED 2026-09-14 after three rounds.** The port decoded
  each contiguous escape run and, when a run held invalid UTF-8, left the whole
  run encoded, so one bad byte hid every valid encoded word after it. It collects
  bytes and does one replacing decode now, which is what Python's `unquote` does.

  The first version of that repair walked UTF-16 units, so a literal astral
  character beside an escape was encoded as two lone surrogates and came back as
  two replacement characters, and `TextDecoder` silently ate a decoded leading
  BOM. Both were ASTRA's neutral controls and both now agree with Python.

  NARROWED rather than closed, round 3. Ordinary, astral and leading-BOM inputs
  agree. A string carrying an UNPAIRED SURROGATE still differs, becoming U+FFFD
  here where Python preserves it, and this API accepts such a request with
  status 200. It is outside scalar Unicode but inside the accepted input
  contract, so either the contract narrows or the decoder changes. Calling it
  closed while the handler still accepts the input was the overstatement.

- **Case equivalence, LITERALS CLOSED and RANGES OPEN, 2026-09-14.** Enumerated
  across every ASCII letter, digit and underscore against all 1,112,064 scalars:
  the entire difference was `i` also matching U+0130 and U+0131. The compiler
  widens a literal `i` to that class and the regexes carry the `u` flag, which
  also gives code point stepping rather than UTF-16 units.

  That closes LITERALS only. A widening pass rewrites a literal; it cannot
  rewrite a RANGE, so `[a-z]` and `[A-Z]` stay narrow here while Python's match
  U+0130 and U+0131 under case-insensitive matching. Measured in both engines
  directly. That drops a match Python makes, turning a block into an allow, and
  133 rules across 140 compiled entries carry such a range. Enumerating literals
  does not close a range, and the earlier CLOSED read as though it had.

- **Whitespace classes, NARROWED 2026-09-14.** Enumerated in both directions:
  Python also matches U+001C to U+001F and U+0085, JavaScript also matches
  U+FEFF. The COMPILED PATTERNS use Python's set.

  The preprocessor does NOT, and this sentence used to claim both. Measured on
  edge trimming, all six characters disagree: Python strips U+001C, U+001D,
  U+001E, U+001F and U+0085 where `collapseWhitespace` leaves them, and
  `collapseWhitespace` strips U+FEFF where Python leaves it. Leading and trailing
  both, interior neither. So the
  normalized view the two engines match against can differ at the edges of a
  document even where the patterns agree.

  The rewrite then broke the any-character idiom, because splicing that set into
  a class beside its own negation drops exactly the character the two definitions
  disagree about; classes holding a shorthand and its negation are left alone.

- **Cost on pathological documents, OPEN.** One corpus document takes 8.2 s here
  against 4.4 s in the pip scanner, about 1.8x, both over any reasonable bound.
  The cost is one rule in both engines. This is a real gap and it is not the
  #157 shape, which is ported and fixed.

- **Decimal digit shorthands, OPEN.** The digit class here misses 750 code
  points Python counts as digits, which drops a match Python makes and turns a
  block into an allow. 37 rules across 41 compiled entries use a digit shorthand
  or its complement.
- **Base64 segment screening, OPEN in three ways.** `str.isprintable()` is
  approximated, which is the long-standing and disclosed part. Beyond it a
  leading BOM is handled differently and a VALID U+FFFD inside a decoded segment
  is stripped here, and neither of those is the same limitation as the
  approximation.
- **100KB request cap** (Workers CPU guard). The pip scanner's own default is
  `MAX_SCAN_BYTES = 1024 * 1024`, applied to the input's length, so "no cap" was
  wrong. It is a different and larger cap, and it is configurable.
- **Keyword lane** iterates keywords (7,098 `indexOf` calls, 6,675 distinct); the pip scanner uses an
  Aho-Corasick automaton when `pyahocorasick` is installed. Same results, different speed
  curve. If p50 latency ever matters, port the automaton.
- **`.` and carriage returns — CLOSED 2026-08-28.** JS `.` excludes `\r`, Python's excludes
  only `\n`, so a carriage return inside a `.{0,N}` span used to split a match the pip
  scanner makes (found by `parity_test.py` on GLS-SC-017 — the CRLF shape a Windows README
  or an HTTP response carries). `compile_patterns.py` now rewrites every unescaped `.` to
  `[^\n]`, giving the JS conversion Python's dot semantics exactly. No longer a delta.

## Performance (local workerd, warm, best-of-5)
| Payload | Wall time |
|---|---|
| 500 chars | 10 ms |
| 2 KB | 27 ms |
| 10 KB | 41 ms |
| 50 KB | 75 ms |

For reference the Python engine scans the same 19KB file in ~710 ms — the JS port is
~8× faster on that input (no Aho-Corasick in either path there).

**Plan implication:** >10 ms CPU means the free tier is out; this needs **Workers Paid**
($5/mo base, covered by the Cloudflare for Startups credits). That was always the plan.

## Known runtime quirk
Cloudflare freezes `Date.now()` during synchronous execution (timing-attack defense), so
`latency_ms` will be `null` in production for pure-CPU scans. The UI hides it rather than
printing a fake `0ms`. Real timing lives in Cloudflare's own metrics.

## Deploy
```bash
npx wrangler dev              # local, http://127.0.0.1:8788
npx wrangler deploy           # → live, routed at sunglasses.dev/api/*
```
Requires the Workers Paid plan on the account. The deployed worker serves whatever
`src/patterns.js` was compiled from — check which release is actually live with
`curl -s https://sunglasses.dev/api/about`, never from this file.
