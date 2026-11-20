#!/usr/bin/env python3
"""
Write tests/fixtures/unicode_case_digests.json from the pinned interpreter's own Unicode data.

Lower case and compatibility normalization (NFKC) of an assigned character are computed by the runtime the Worker runs
on. What holds them equal to the pinned Unicode version is a test: this file carries, per block of 1,024 code points, a
digest of what the interpreter the pip scanner is measured on makes of every assigned code point, and
tests/unicode_case_digests.test.mjs computes the same digests from the runtime and compares. The edge probe
(tools/edge_unicode_probe.sh) does the same on the edge.

    /opt/homebrew/opt/python@3.14/bin/python3.14 compile_unicode_case_digests.py

It refuses to run on any other Unicode version, so the file cannot drift by accident. The text hashed per block is the
one tools/unicode_case_digest.js builds: a line per assigned code point, "<cp> <lower> <nfkc>", each as hex code points
joined by commas.
"""
import hashlib
import json
import sys
import unicodedata
from pathlib import Path

PINNED = "16.0.0"
BLOCK = 1024
OUT = Path(__file__).parent / "tests" / "fixtures" / "unicode_case_digests.json"


def hexlist(s):
    return ",".join("%x" % ord(c) for c in s)


def main():
    if unicodedata.unidata_version != PINNED:
        sys.exit("this interpreter reads Unicode %s; the digests are pinned to %s" % (unicodedata.unidata_version, PINNED))
    blocks, assigned = {}, 0
    for start in range(0, 0x110000, BLOCK):
        lines = []
        for cp in range(start, min(start + BLOCK, 0x110000)):
            if 0xD800 <= cp <= 0xDFFF:
                continue
            ch = chr(cp)
            if unicodedata.category(ch) == "Cn":
                continue
            lines.append("%x %s %s\n" % (cp, hexlist(ch.lower()), hexlist(unicodedata.normalize("NFKC", ch))))
        if lines:
            assigned += len(lines)
            blocks["%x" % start] = hashlib.sha256("".join(lines).encode("utf-8")).hexdigest()
    doc = {
        "unicode": unicodedata.unidata_version,
        "python": sys.version.split()[0],
        "block_size": BLOCK,
        "assigned": assigned,
        "blocks": blocks,
    }
    OUT.write_text(json.dumps(doc, indent=0, sort_keys=False) + "\n")
    print("wrote %s: %d blocks, %d assigned code points, Unicode %s" % (OUT, len(blocks), assigned, unicodedata.unidata_version))


if __name__ == "__main__":
    main()
