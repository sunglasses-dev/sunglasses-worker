#!/usr/bin/env python3
"""Every short text the scanner stops (quarantine or block), as written, is stopped at least as hard by the Worker.

The pool is rebuilt from the scanner's own sources on each run: the positive sample of every rule
(tests/rule_positive_samples.json of the scanner checkout), for every compiled rule its name, its keyword
literals and its description on the channels the rule reads, and every string the scanner's tests hold that one of
its structural readers takes up, on the channels that reader reads. A text is kept when it is at most 600 characters
and the scanner stops it. The scanner is run here, so the pool follows the pinned release.

  SUNGLASSES_SRC=<scanner dir> SUNGLASSES_TESTS=<scanner tests dir> python3 release_stopped_parity.py
Exit 0 when no text in the pool is decided lower by the Worker than by the scanner.
"""
import ast
import glob
import json
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCANNER = os.environ.get("SUNGLASSES_SRC", os.path.expanduser("~/sunglasses-dev/glasses"))
TESTS = os.environ.get("SUNGLASSES_TESTS", os.path.join(SCANNER, "tests"))
sys.path.insert(0, SCANNER)
from sunglasses.engine import SunglassesEngine  # noqa: E402
from sunglasses.validators import VALIDATORS  # noqa: E402

MAX_TEXT = 600
RANK = {"allow": 0, "allow_redacted": 1, "quarantine": 2, "block": 3}


def compiled_rules():
    """The rules the Worker ships, read from src/patterns.js: name, keywords, description and channels."""
    out = subprocess.run(
        ["node", "-e", "import('./src/patterns.js').then(m=>console.log(JSON.stringify(m.PATTERNS.map(p=>"
         "({n:p.name,k:p.keywords||[],d:p.description||'',c:p.channel||[]}))))) "],
        cwd=HERE, capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def pool():
    seen = {}
    def add(text, channel):
        if isinstance(text, str) and 0 < len(text) <= MAX_TEXT and isinstance(channel, str):
            seen.setdefault((text, channel), None)
    with open(os.path.join(TESTS, "rule_positive_samples.json"), encoding="utf-8") as handle:
        for sample in json.load(handle).values():
            for channel in sample.get("channels", []):
                add(sample.get("text"), channel)
    for rule in compiled_rules():
        for text in [rule["n"], rule["d"], *rule["k"]]:
            for channel in rule["c"]:
                add(text, channel)
    for path in sorted(glob.glob(os.path.join(TESTS, "test_*.py"))):
        try:
            with open(path, encoding="utf-8") as handle:
                tree = ast.parse(handle.read())
        except (OSError, SyntaxError, ValueError):
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and 8 <= len(node.value) <= MAX_TEXT:
                for reader in VALIDATORS:
                    if reader.pregate(node.value):
                        for channel in reader.channel:
                            add(node.value, channel)
    return list(seen)


def main():
    engine = SunglassesEngine()
    stopped = []
    for text, channel in pool():
        decision = engine.scan(text, channel=channel).decision
        if RANK[decision] >= RANK["quarantine"]:
            stopped.append((text, channel, decision))
    with tempfile.TemporaryDirectory() as tmp:
        rows, answers = os.path.join(tmp, "rows.json"), os.path.join(tmp, "answers.json")
        with open(rows, "w", encoding="utf-8") as handle:
            json.dump([[t, c] for t, c, _ in stopped], handle)
        subprocess.run(["node", os.path.join(HERE, "release_stopped_worker.mjs"), rows, answers], check=True)
        with open(answers, encoding="utf-8") as handle:
            worker = json.load(handle)
    lower = [(t, c, d, w) for (t, c, d), w in zip(stopped, worker) if RANK[w] < RANK[d]]
    stricter = sum(1 for (t, c, d), w in zip(stopped, worker) if RANK[w] > RANK[d])
    print(f"texts the scanner stops: {len(stopped)}; Worker decides lower: {len(lower)}; stricter: {stricter}")
    for text, channel, decision, got in lower[:20]:
        print(f"  {channel} scanner={decision} worker={got} {text[:100]!r}")
    return 1 if lower else 0


if __name__ == "__main__":
    sys.exit(main())
