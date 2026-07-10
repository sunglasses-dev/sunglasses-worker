# Sunglasses Worker — hosted scan demo

Zero-install demo of the Sunglasses AI-agent input scanner, running on Cloudflare Workers.
The **pip package stays the product of record**; this is a try-before-install front door
(and the "core infra on Workers" that Workers Launchpad eligibility asks for).

**Status: built + locally verified Jul 8 2026. NOT deployed — awaiting AZ's GO.**

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
v0.2.73) and emits `src/patterns.js`. Nothing is hand-copied. Then three gates run:

| Gate | What it proves | Result |
|---|---|---|
| `compile_patterns.py` | every regex converts + compiles in V8 | **1112/1112 ported, 0 failed** |
| `parity_test.py` | each converted regex matches the same strings as Python (generated positives + benign corpus) | **758 regexes, 0 misses · 9,384 benign checks, 0 disagreements** |
| `engine_parity.py` | end-to-end verdict parity on attack canaries, negation cases, clean files | **22 cases, 0 disagreements** |
| `wide_parity.py` | 305 corpus cases (harvested from the scanner's own test suite) × 5 channels | **1,525 pairs, 0 verdict splits, 0 finding-set deltas** |

Re-run all of it: `python3 compile_patterns.py && python3 parity_test.py && python3 engine_parity.py && python3 wide_parity.py`

## Honest deltas vs the pip scanner
- **Unicode word boundaries.** JS `\w`/`\b` are ASCII-only; Python's are unicode-aware.
  Homoglyph normalization runs first and closes most of the gap, but a payload using
  unicode letters *inside* a `\w` span can differ. Surfaced in `/about`.
- **HTML entities.** Python decodes the full HTML5 named-entity set; we decode numeric
  entities + the ~30 named ones that matter for injection. Numeric is what attacks use.
- **`str.isprintable()`** is approximated for base64-segment screening.
- **100KB request cap** (Workers CPU guard). The pip scanner has no cap.
- **Keyword lane** iterates keywords (7,281 `indexOf` calls); the pip scanner uses an
  Aho-Corasick automaton when `pyahocorasick` is installed. Same results, different speed
  curve. If p50 latency ever matters, port the automaton.

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

## Deploy (NOT YET RUN — needs AZ)
```bash
npx wrangler dev              # local, http://127.0.0.1:8788
npx wrangler deploy           # → sunglasses-scan.<subdomain>.workers.dev
```
Deploying creates a public URL and requires the Workers Paid plan on the account.
