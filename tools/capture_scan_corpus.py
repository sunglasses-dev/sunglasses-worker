#!/usr/bin/env python3
"""Record every default-engine scan() call a set of scanner test files makes.

Usage (run from a scanner checkout, so `sunglasses` imports from there):
    python3 capture_scan_corpus.py OUT.json TEST_FILE [TEST_FILE ...]

The scanner's own tests are the densest set of hand-built inputs for the
behaviours the Worker engine must reproduce (folded view, negation walk,
framing walk). This runs them under a recorder that wraps
`SunglassesEngine.scan`, and writes one row per distinct (text, channel):
the decision and the sorted finding ids the Python engine returned. The
Worker replays the same rows (tests/scan_corpus_parity.test.mjs) and must
return the same decision and the same finding ids.

Only the default engine is recorded (stock rules, mechanisms on, default scan
cap), because that is the engine the Worker is. Inputs over MAX_CHARS are
counted and left out.
"""
import json
import sys

import pytest

MAX_CHARS = 20000
ROWS = {}
SKIPPED = {"non_default_engine": 0, "too_long": 0, "raised": 0}


class Recorder:
    def pytest_configure(self, config):
        from sunglasses import engine as eng
        from sunglasses.mechanisms import MECHANISM_PATTERNS
        from sunglasses.patterns import PATTERNS

        cls = eng.SunglassesEngine
        real = cls.scan
        want = len(PATTERNS) + len(MECHANISM_PATTERNS)

        def wrapped(self, text, channel="message"):
            try:
                result = real(self, text, channel)
            except Exception:
                SKIPPED["raised"] += 1
                raise
            default = (len(self._patterns) == want
                       and self.max_scan_bytes == eng.MAX_SCAN_BYTES)
            if not default:
                SKIPPED["non_default_engine"] += 1
            elif len(text) > MAX_CHARS:
                SKIPPED["too_long"] += 1
            else:
                key = json.dumps([text, channel], ensure_ascii=True)
                ROWS[key] = {
                    "text": text, "channel": channel,
                    "decision": result.decision,
                    "ids": sorted({f["id"] for f in result.findings}),
                }
            return result

        cls.scan = wrapped


def main():
    out, files = sys.argv[1], sys.argv[2:]
    code = pytest.main(["-q", "-p", "no:cacheprovider", "--no-header",
                        "-W", "ignore", *files], plugins=[Recorder()])
    rows = sorted(ROWS.values(), key=lambda r: (r["channel"], r["text"]))
    with open(out, "w", encoding="utf8") as fh:
        json.dump({"rows": rows, "skipped": SKIPPED}, fh, ensure_ascii=True)
    print(f"rows={len(rows)} skipped={SKIPPED} pytest_exit={int(code)}")


if __name__ == "__main__":
    main()
