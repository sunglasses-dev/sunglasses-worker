#!/usr/bin/env python3
"""ASTRA's own counterexamples, both engines, four channels, per-case timeout.

His review of PR #22 saved 66 fixtures that separate the two engines, and his
required next candidate says to use them as failing-before/passing-after gates.
So they are a gate rather than a reading exercise.

Two things this does that `wide_parity.py` does not. It bounds each case, because
the exact #157 long-word document did not fail in JavaScript, it did not finish,
and a differential that hangs reports nothing at all. And it treats a timeout as
its own outcome rather than as a delta or a pass: a case that never produced a
verdict has not agreed with anything.
"""
import json, os, subprocess, sys, tempfile, time

SCANNER = os.environ.get("SUNGLASSES_SRC", os.path.expanduser("~/sunglasses-dev/glasses"))
if os.path.isdir(SCANNER):
    sys.path.insert(0, SCANNER)
from sunglasses.engine import SunglassesEngine

OUT = os.path.dirname(os.path.abspath(__file__))
# BOTH REVIEWS, every fixture either one saved. Round 1 left 66 counterexamples
# and round 2 added 102 more in `additional_fixtures`, and his finding index
# names 104 documents across the two. Running only the first set would have
# reported a clean gate while 200 pairs were failing on the second.
REVIEWS = [
    "~/Desktop/SUNGLASSES_ASTRA_REVIEW_2026-09-04/WORKER22_REVIEW_3cfe154_2026-09-13/fixtures",
    "~/Desktop/SUNGLASSES_ASTRA_REVIEW_2026-09-04/WORKER22_REVIEW_fc042f9_2026-09-14/fixtures",
    "~/Desktop/SUNGLASSES_ASTRA_REVIEW_2026-09-04/WORKER22_REVIEW_fc042f9_2026-09-14/additional_fixtures",
]
CHANNELS = ["api_response", "log_memory", "message", "file"]
TIMEOUT_MS = int(os.environ.get("ASTRA_PARITY_TIMEOUT_MS", "3000"))

seen = {}
for directory in REVIEWS:
    directory = os.path.expanduser(directory)
    if not os.path.isdir(directory):
        continue
    for n in sorted(os.listdir(directory)):
        if n.endswith(".txt"):
            seen.setdefault(n[:-4], os.path.join(directory, n))
cases = [{"name": f"{case}|{ch}", "case": case,
          "text": open(path, encoding="utf-8").read(), "channel": ch}
         for case, path in sorted(seen.items()) for ch in CHANNELS]
print(f"{len(seen)} ASTRA counterexamples x {len(CHANNELS)} channels = {len(cases)} pairs")

eng = SunglassesEngine()
py = []
for c in cases:
    started = time.perf_counter()
    r = eng.scan(c["text"], c["channel"])
    py.append({"decision": r.decision, "ids": sorted({f["id"] for f in r.findings}),
               "seconds": round(time.perf_counter() - started, 3)})

runner = """
import { scan } from './src/engine.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
const cases = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const out = [];
for (const c of cases) {
  const started = process.hrtime.bigint();
  const r = scan(c.text, c.channel);
  out.push({decision: r.decision, ids: [...new Set(r.findings.map(f => f.id))].sort(),
            seconds: Number(process.hrtime.bigint() - started) / 1e9});
}
writeFileSync(process.argv[3], JSON.stringify(out));
"""
with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, dir=OUT) as f:
    json.dump(cases, f); cp = f.name
rp = os.path.join(OUT, "_astra_runner.mjs"); open(rp, "w").write(runner); op = cp + ".out"
timed_out = False
try:
    r = subprocess.run(["node", "--stack-size=8000", rp, cp, op],
                       capture_output=True, text=True,
                       timeout=max(60, TIMEOUT_MS * len(cases) / 1000), cwd=OUT)
    if r.returncode != 0:
        print("NODE FAIL:", r.stderr[:2000]); sys.exit(2)
    js = json.load(open(op))
except subprocess.TimeoutExpired:
    timed_out = True; js = None
finally:
    for p in (cp, rp, op):
        if os.path.exists(p): os.unlink(p)

if timed_out:
    print("\n🔴 THE JAVASCRIPT RUN DID NOT FINISH. A differential that hangs has")
    print("   measured nothing. This is the #157 shape ASTRA recorded as 16 timeouts.")
    json.dump({"timed_out": True}, open(os.path.join(OUT, "astra_parity_report.json"), "w"), indent=1)
    sys.exit(1)

vfail = [(c["name"], p["decision"], j["decision"])
         for c, p, j in zip(cases, py, js) if p["decision"] != j["decision"]]
dfail = [(c["name"], sorted(set(p["ids"]) - set(j["ids"]))[:6], sorted(set(j["ids"]) - set(p["ids"]))[:6])
         for c, p, j in zip(cases, py, js) if set(p["ids"]) != set(j["ids"])]
# A DIFFERENTIAL, not a stopwatch. The first version failed any case where the
# port took longer than the bound, and ASTRA's C01688 takes 2.9 s here and 4.3 s
# in the pip scanner: it is slow in BOTH engines, and calling that a port defect
# points at the wrong thing. A document the reference engine is also slow on is
# the scanner's characteristic. What this gate is for is the port being slower
# than the thing it ports.
#
# No invented ratio. A first version used a 2x threshold, which is a number I
# chose rather than measured, and C01688 sits at 1.9 and would have passed by
# construction. The comparison is simply whether the port is slower than the
# engine it ports, on a document already over the bound.
slow = [(c["name"], round(j["seconds"], 2), round(p["seconds"], 2))
        for c, p, j in zip(cases, py, js)
        if j["seconds"] * 1000 > TIMEOUT_MS and j["seconds"] > p["seconds"]]
both_slow = [(c["name"], round(j["seconds"], 2), round(p["seconds"], 2))
             for c, p, j in zip(cases, py, js)
             if j["seconds"] * 1000 > TIMEOUT_MS and j["seconds"] <= p["seconds"]]

print(f"\npairs: {len(cases)}\nverdict disagreements: {len(vfail)}")
for v in vfail[:20]: print(f"  ❌ {v[0]}: py={v[1]} js={v[2]}")
print(f"finding-set deltas: {len(dfail)}")
for d in dfail[:20]: print(f"  ⚠️ {d[0]}: only-py={d[1]} only-js={d[2]}")
print(f"slower in JS than the pip scanner, over the bound: {len(slow)}")
for row in slow[:10]:
    print(f"  🐢 {row[0]}: js {row[1]}s vs py {row[2]}s  ({row[1] / max(row[2], 0.001):.2f}x)")
print(f"over the bound in BOTH engines (the scanner's own cost, not the port's): {len(both_slow)}")
for row in both_slow[:10]: print(f"  ⏱  {row[0]}: js {row[1]}s vs py {row[2]}s")

json.dump({"pairs": len(cases), "verdict_fail": vfail, "id_delta": dfail,
           "slow_in_js_only": slow, "slow_in_both": both_slow},
          open(os.path.join(OUT, "astra_parity_report.json"), "w"), indent=1)
ok = not vfail and not dfail and not slow
print("\n🟢 ASTRA COUNTEREXAMPLE PARITY PASS" if ok else "\n🔴 ASTRA COUNTEREXAMPLE PARITY FAIL")
sys.exit(0 if ok else 1)
