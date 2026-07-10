#!/usr/bin/env python3
"""Behavioral parity gate: for every ported regex, generate a string the PYTHON pattern
matches (exrex), then assert the JS conversion matches the same string in Node.
Also: Python-vs-JS verdict agreement on a benign corpus (no one-sided fires).

Exit 0 only if zero disagreements."""
import json
import os
import re
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.expanduser("~/sunglasses-dev/glasses"))
from sunglasses.patterns import PATTERNS  # noqa: E402
import exrex  # noqa: E402

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
compiled = {e["id"]: e for e in json.loads(
    open(os.path.join(OUT_DIR, "src", "patterns.js")).read().split("export const PATTERNS = ", 1)[1].rstrip(";\n"))}

# ---------- layer A: generated positive samples ----------
cases = []      # {id, ri, source, flags, sample}
nogen = []      # patterns exrex couldn't generate for (lookaheads etc.)
for p in PATTERNS:
    entry = compiled.get(p["id"])
    if not entry or not entry["regex"]:
        continue
    for ri, (py_rx, js_rx) in enumerate(zip(p["regex"], entry["regex"])):
        sample = None
        try:
            # Prefer ASCII samples: Python \w/\b are unicode-aware, JS's are ASCII-only.
            # That delta is documented as a known limitation, not a conversion bug —
            # here we verify the CONVERSION on the ASCII plane where both agree.
            for attempt in range(24):
                cand = exrex.getone(py_rx, limit=6)
                if cand and cand.isascii() and re.search(py_rx, cand, re.IGNORECASE):
                    sample = cand
                    break
        except Exception:
            pass
        if sample is None:
            nogen.append(f"{p['id']}[{ri}]")
            continue
        cases.append({"id": p["id"], "ri": ri, "source": js_rx["source"],
                      "flags": js_rx["flags"], "sample": sample})

# ---------- layer B: benign corpus agreement ----------
benign = [
    "The quarterly report shows steady growth across all regions this year.",
    "def add(a, b):\n    return a + b\n# simple math helper",
    "Please review the attached invoice and confirm receipt by Friday.",
    "This library parses YAML configuration files for the deployment pipeline.",
    "Set the timeout to 30 seconds and retry three times on network failure.",
    "The museum opens at 9am; tickets are cheaper on weekdays.",
    "npm install express && node server.js  # starts the demo server",
    "Our team shipped the new dashboard with dark mode support last week.",
]
corpus_checks = []
for p in PATTERNS:
    entry = compiled.get(p["id"])
    if not entry or not entry["regex"]:
        continue
    for ri, (py_rx, js_rx) in enumerate(zip(p["regex"], entry["regex"])):
        for ti, text in enumerate(benign):
            py_hit = bool(re.search(py_rx, text, re.IGNORECASE))
            corpus_checks.append({"id": p["id"], "ri": ri, "ti": ti, "source": js_rx["source"],
                                  "flags": js_rx["flags"], "sample": text, "expect": py_hit})

node_js = """
const fs = require('fs');
const items = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = items.map(it => {
  try { return new RegExp(it.source, it.flags).test(it.sample); }
  catch (e) { return 'ERR:' + e.message.slice(0, 80); }
});
fs.writeFileSync(process.argv[3], JSON.stringify(out));
"""

def run_node(items):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(items, f); inp = f.name
    outp = inp + ".out"
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
        f.write(node_js); jsp = f.name
    try:
        r = subprocess.run(["node", jsp, inp, outp], capture_output=True, text=True, timeout=600)
        if r.returncode != 0:
            raise RuntimeError(r.stderr[:300])
        return json.load(open(outp))
    finally:
        for pth in (inp, jsp, outp):
            if os.path.exists(pth): os.unlink(pth)

resA = run_node(cases)
failA = [(c["id"], c["ri"], repr(c["sample"][:60]), r) for c, r in zip(cases, resA) if r is not True]

resB = run_node(corpus_checks)
failB = [(c["id"], c["ri"], c["ti"], c["expect"], r) for c, r in zip(corpus_checks, resB) if r != c["expect"]]

print(f"layer A (generated positives): {len(cases)} regexes tested, {len(failA)} JS misses, {len(nogen)} not generatable")
for f_ in failA[:10]: print("  ❌", f_)
print(f"layer B (benign agreement):    {len(corpus_checks)} checks, {len(failB)} disagreements")
for f_ in failB[:10]: print("  ❌", f_)
json.dump({"layerA_tested": len(cases), "layerA_fail": failA, "not_generatable": nogen,
           "layerB_checks": len(corpus_checks), "layerB_fail": failB},
          open(os.path.join(OUT_DIR, "parity_report.json"), "w"), indent=1)
verdict = "🟢 PARITY PASS" if not failA and not failB else "🔴 PARITY FAIL"
print(verdict)
sys.exit(0 if not failA and not failB else 1)
