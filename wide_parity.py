#!/usr/bin/env python3
"""Wide differential: 305 corpus cases x 5 channels through both engines."""
import json, os, subprocess, sys, tempfile
SCANNER = os.environ.get("SUNGLASSES_SRC", os.path.expanduser("~/sunglasses-dev/glasses"))
if os.path.isdir(SCANNER):
    sys.path.insert(0, SCANNER)  # fall back to installed package (CI: pip install sunglasses)
from sunglasses.engine import SunglassesEngine
OUT = os.path.dirname(os.path.abspath(__file__))
raw = json.load(open(os.path.join(OUT, "corpus", "wide_corpus.json")))
CHANNELS = ["message", "file", "api_response", "web_content", "log_memory"]
cases = [{"name": f"{c['name']}|{ch}", "text": c["text"], "channel": ch} for c in raw for ch in CHANNELS]
print(f"running {len(cases)} case-channel pairs through both engines...")
eng = SunglassesEngine()
py = [{"decision": (r := eng.scan(c["text"], c["channel"])).decision, "ids": sorted({f['id'] for f in r.findings})} for c in cases]
runner = """
import { scan } from './src/engine.js';
import { readFileSync, writeFileSync } from 'node:fs';
const cases = JSON.parse(readFileSync(process.argv[2],'utf8'));
writeFileSync(process.argv[3], JSON.stringify(cases.map(c => { const r = scan(c.text, c.channel);
  return {decision: r.decision, ids: [...new Set(r.findings.map(f=>f.id))].sort()}; })));
"""
with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, dir=OUT) as f:
    json.dump(cases, f); cp = f.name
rp = os.path.join(OUT, "_wide_runner.mjs"); open(rp,"w").write(runner); op = cp + ".out"
try:
    r = subprocess.run(["node","--stack-size=8000",rp,cp,op], capture_output=True, text=True, timeout=1800, cwd=OUT)
    if r.returncode != 0: print("NODE FAIL:", r.stderr[:1500]); sys.exit(2)
    js = json.load(open(op))
finally:
    for p in (cp, rp, op):
        if os.path.exists(p): os.unlink(p)
vfail = [(c["name"], p["decision"], j["decision"]) for c,p,j in zip(cases,py,js) if p["decision"] != j["decision"]]
dfail = [(c["name"], sorted(set(p["ids"])-set(j["ids"]))[:5], sorted(set(j["ids"])-set(p["ids"]))[:5])
         for c,p,j in zip(cases,py,js) if set(p["ids"]) != set(j["ids"])]
print(f"\ncases: {len(cases)}\nverdict disagreements: {len(vfail)}")
for v in vfail[:15]: print(f"  ❌ {v[0]}: py={v[1]} js={v[2]}")
print(f"finding-set deltas: {len(dfail)}")
for d in dfail[:15]: print(f"  ⚠️ {d[0]}: only-py={d[1]} only-js={d[2]}")
json.dump({"verdict_fail": vfail, "id_delta": dfail}, open(os.path.join(OUT,"wide_parity_report.json"),"w"), indent=1)
print("\n🟢 WIDE PARITY PASS" if not vfail else f"\n🔴 WIDE PARITY FAIL ({len(vfail)} verdict splits)")
sys.exit(0 if not vfail else 1)
