# Sunglasses Worker — hosted scan demo

Zero-install demo of the Sunglasses AI-agent input scanner, running on Cloudflare Workers.
The **pip package stays the product of record**; this is a try-before-install front door
(and the "core infra on Workers" that Workers Launchpad eligibility asks for).

**Status: demo build, fully parity-tested against the pip scanner (gates below). Hosted demo: https://sunglasses.dev/api/ (same-origin mount of this Worker; `/scan` is Turnstile-gated). `pip install sunglasses` remains the product of record.**

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
v0.4.9) and emits `src/patterns.js`. Nothing is hand-copied. Then four gates run:

| Gate | What it proves | Result (measured 2026-08-28, scanner v0.4.9) |
|---|---|---|
| `compile_patterns.py` | every regex converts + compiles in V8 | **1407/1407 ported, 0 failed** |
| `parity_test.py` | each converted regex matches the same strings as Python (generated positives + benign corpus) | **~820 regexes/run, 0 misses · 11,432 benign checks, 0 disagreements** |
| `engine_parity.py` | end-to-end verdict parity on attack canaries, negation cases, clean files, the full benchmark + FP corpora | **136 cases, 0 verdict splits, 0 finding-set deltas** |
| `policy_parity.py` | the repo-scan rollup ladder agrees py-vs-js | **14 cases, 0 mismatches** |
| `wide_parity.py` | 311 corpus cases (harvested from the scanner's own test suite) × 5 channels | **1,555 pairs, 0 verdict splits, 0 finding-set deltas** |

`parity_test.py` generates its positive samples randomly (exrex), so the regex count moves
run to run — that randomness is what keeps finding new conversion holes. It prints its seed
every run; replay a failure with `PARITY_SEED=<seed> python3 parity_test.py`.

Re-run all of it: `python3 compile_patterns.py && python3 parity_test.py && python3 engine_parity.py && python3 policy_parity.py && python3 wide_parity.py`

## Honest deltas vs the pip scanner
- **Unicode word boundaries.** JS `\w`/`\b` are ASCII-only; Python's are unicode-aware.
  Homoglyph normalization runs first and closes most of the gap, but a payload using
  unicode letters *inside* a `\w` span can differ. Surfaced in `/about`.
- **HTML entities.** Python decodes the full HTML5 named-entity set; we decode numeric
  entities + the ~30 named ones that matter for injection. Numeric is what attacks use.
- **`str.isprintable()`** is approximated for base64-segment screening.
- **100KB request cap** (Workers CPU guard). The pip scanner has no cap.
- **Keyword lane** iterates keywords (7,024 `indexOf` calls); the pip scanner uses an
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
