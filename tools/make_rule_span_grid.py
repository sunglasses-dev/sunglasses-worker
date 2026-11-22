#!/usr/bin/env python3
"""Write tests/fixtures/scan_corpus_rule_span_grid.json: the answers of the scanner (pip) on the products of the scanner's own
span test for one rule, so the Worker can be held to them.

The products are NOT retyped here. They are read by code from the scanner's test module (`_family`, `_seeded`, the same seeds), so
a change to the products there moves this grid with it the next time this script runs.

For each text and each channel the rule declares, the fixture keeps the decision the scanner gives, whether the rule is among the
findings, and the text it matched (the span, read as text). The rule's expression is the one the scanner ships, run in the scanner's
own engine: that is "pip".

usage: python3 tools/make_rule_span_grid.py <scanner tree> [--module <span test module>] [--stride N --stride-head H] > tests/fixtures/<grid file>.json
"""
import argparse
import importlib
import itertools
import json
import os
import sys

ap = argparse.ArgumentParser()
ap.add_argument("scanner")
ap.add_argument("--module", default="test_sql_filter_query_rule_spans", help="the scanner test module that builds the texts of one rule")
ap.add_argument("--stride-head", type=int, default=20160, help="how many texts at the head of the family the stride applies to (0 = none)")
ap.add_argument("--stride", type=int, default=3, help="keep every Nth text of the first --stride-head texts of the family (the rest and the seeded texts are kept whole)")
args = ap.parse_args()
root = os.path.abspath(args.scanner)
sys.path[:0] = [root, os.path.join(root, "tests")]
T = importlib.import_module(args.module)
import sunglasses  # noqa: E402
from sunglasses.engine import SunglassesEngine  # noqa: E402

if os.path.commonpath([os.path.dirname(os.path.abspath(sunglasses.__file__)), root]) != root:
    sys.exit("REFUSED: sunglasses imported from outside the scanner tree given")

engine = SunglassesEngine()
channels = list(T.RULE["channel"])
texts, seen = [], set()
for i, text in enumerate(itertools.chain(T._family(), T._seeded(6000, 11), T._seeded(6000, 12))):
    keep = i % args.stride == 0 if i < args.stride_head else True
    if keep and text not in seen:
        seen.add(text)
        texts.append(text)

rows, hits = [], 0
letter = {"allow": "a", "allow_redacted": "r", "quarantine": "q", "block": "b"}
for text in texts:
    code, matched = "", None  # matched is set by the first channel
    for ch in channels:
        res = engine.scan(text, ch)
        code += letter[res.decision]
        mine = [f.get("matched_text") for f in res.findings if f["id"] == T.RULE_ID]
        got = mine[0] if mine else None
        if ch != channels[0] and got != matched:
            sys.exit("REFUSED: the rule matched different text on two channels; this grid keeps one answer per text")
        matched = got
    hits += matched is not None
    rows.append([text, code, matched])
json.dump({"scanner": sunglasses.__version__, "rule": T.RULE_ID, "channels": channels, "decision_letters": letter, "texts": len(rows), "texts_with_a_match": hits,
           "rows": rows}, sys.stdout, ensure_ascii=True, separators=(",", ":"))
sys.stdout.write("\n")
