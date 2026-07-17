#!/usr/bin/env python3
"""Policy parity: the JS policy mirror (src/policy.js) must roll up repo scans
byte-for-byte like the Python reference (sunglasses/policy.py).

Deterministic synthetic cases exercise every rung of the ladder: clean,
notes-only, the mempalace shape (distinct categories never corroborate),
same-category corroboration, keyword-only Tier-B, negation-review findings,
duplicate ids, cross-file isolation, and an injected Tier-S signature."""
import json, os, subprocess, sys, tempfile

SCANNER = os.environ.get("SUNGLASSES_SRC", os.path.expanduser("~/sunglasses-dev/glasses"))
if os.path.isdir(SCANNER):
    sys.path.insert(0, SCANNER)  # fall back to installed package (CI: pip install sunglasses)
from sunglasses import policy
from sunglasses.patterns import PATTERNS

OUT = os.path.dirname(os.path.abspath(__file__))

KW = [p["id"] for p in PATTERNS if not p.get("regex")][:2]
RX = [p["id"] for p in PATTERNS if p.get("regex")][:1]


def F(id, sev, cat="prompt_injection", span="x"):
    return {"id": id, "severity": sev, "category": cat, "matched_text": span}


CASES = [
    {"name": "clean", "files": [{"name": "README.md", "findings": []}]},
    {"name": "single-note", "files": [{"name": "README.md", "findings": [F("GLS-X-1", "high")]}]},
    {"name": "mempalace-shape", "files": [{"name": "README.md", "findings": [
        F("GLS-A-1", "high", "prompt_injection"),
        F("GLS-B-1", "medium", "privilege_escalation"),
        F("GLS-C-1", "critical", "prompt_leak")]}]},
    {"name": "corroborated-distinct-spans", "files": [{"name": "README.md", "findings": [
        F("GLS-A-1", "high", span="ignore previous instructions"),
        F("GLS-A-2", "critical", span="reveal your system prompt")]}]},
    {"name": "same-span-single-evidence", "files": [{"name": "README.md", "findings": [
        F("GLS-A-1", "high", "supply_chain", span="bash x/uninstall.sh"),
        F("GLS-A-2", "critical", "supply_chain", span="bash x/uninstall.sh")]}]},
    {"name": "cross-file-no-corroboration", "files": [
        {"name": "a.md", "findings": [F("GLS-A-1", "high")]},
        {"name": "b.md", "findings": [F("GLS-A-2", "high")]}]},
    {"name": "dupe-id-no-corroboration", "files": [{"name": "README.md", "findings": [
        F("GLS-A-1", "high"), F("GLS-A-1", "high")]}]},
    {"name": "medium-never-corroborates", "files": [{"name": "README.md", "findings": [
        F("GLS-A-1", "medium"), F("GLS-A-2", "medium")]}]},
    {"name": "keyword-only-tier-b", "files": [{"name": "README.md", "findings": [
        F(KW[0], "high"), F(KW[1], "high")]}]},
    {"name": "review-severity-defused", "files": [{"name": "README.md", "findings": [
        F("GLS-A-1", "review"), F("GLS-A-2", "review")]}]},
    {"name": "regex-plus-keyword-mixed", "files": [{"name": "README.md", "findings": [
        F(RX[0], "high"), F(KW[0], "high")]}]},
    {"name": "tier-s-known-attack", "tier_s": ["GLS-SIG-1"], "files": [
        {"name": "README.md", "findings": [F("GLS-SIG-1", "critical"), F("GLS-A-1", "high")]}]},
    {"name": "multi-file-mixed", "files": [
        {"name": "README.md", "findings": [F("GLS-A-1", "high"), F("GLS-A-2", "high")]},
        {"name": "CLAUDE.md", "findings": [F("GLS-B-1", "low", "privilege_escalation")]},
        {"name": "mcp.json", "findings": []}]},
]

py = [policy.rollup_repo(c["files"], frozenset(c.get("tier_s", []))) for c in CASES]

runner = """
import { rollupRepo } from './src/policy.js';
import { readFileSync, writeFileSync } from 'node:fs';
const cases = JSON.parse(readFileSync(process.argv[2],'utf8'));
writeFileSync(process.argv[3], JSON.stringify(cases.map(c =>
  rollupRepo(c.files, new Set(c.tier_s ?? [])))));
"""
with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, dir=OUT) as f:
    json.dump(CASES, f); cp = f.name
rp = os.path.join(OUT, "_policy_runner.mjs"); open(rp, "w").write(runner); op = cp + ".out"
try:
    r = subprocess.run(["node", rp, cp, op], capture_output=True, text=True, timeout=120, cwd=OUT)
    if r.returncode != 0: print("NODE FAIL:", r.stderr[:1500]); sys.exit(2)
    js = json.load(open(op))
finally:
    for p in (cp, rp, op):
        if os.path.exists(p): os.unlink(p)

fails = []
for c, p, j in zip(CASES, py, js):
    if p != j:
        fails.append(c["name"])
        print(f"  ❌ {c['name']}:\n     py={json.dumps(p, sort_keys=True)}\n     js={json.dumps(j, sort_keys=True)}")
print(f"\ncases: {len(CASES)} · mismatches: {len(fails)}")
print("🟢 POLICY PARITY PASS" if not fails else f"🔴 POLICY PARITY FAIL ({len(fails)})")
sys.exit(0 if not fails else 1)
