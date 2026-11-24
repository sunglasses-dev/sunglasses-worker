"""The Worker's marker is the scanner's marker, byte for byte.

src/door_mask.js ports the scanner's sunglasses/door_mask.py. A hand port drifts, so this test builds documents of
the shapes the Worker returns (a scan result, a repo report) and runs the same document through the scanner's
mask_document (the pinned package, or the source tree named in SUNGLASSES_SRC) and through maskDocument in node.
The two answers must be equal. The keys are made up from pieces.

Run with python3 -m unittest tests/test_door_mask_parity.py from the Worker folder.
"""
import json
import os
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCANNER = os.environ.get("SUNGLASSES_SRC", "")
if SCANNER and os.path.isdir(SCANNER):
    sys.path.insert(0, SCANNER)
from sunglasses.door_mask import mask_document  # noqa: E402

AWS = "AK" + "IA" + "ZQ7XK2M9P4WL8TNB"
GH = "ghp_" + "Q7xK2m9P4wL8tNbV3cR6yH1jD5sF0aZe9uGq"
SLACK = "xox" + "b-" + "1234567890-" + "0987654321098-" + "AbCdEfGhIjKlMnOpQrStUvWx"
LEET = "AK" + "1A" + "ZQ7XK2M9P4WL8TNB"
WIDE = "tok_" + "\U0001d4d0" + "Zq7Xk2M9p4Wl8TnB3cR6yH1jD5"


def finding(id_, category, matched, shown=None, severity="high"):
    f = {"id": id_, "category": category, "severity": severity, "matched_text": matched}
    if shown is not None:
        f["shown_text"] = shown
    return f


def documents():
    docs = []
    for key, rid in ((AWS, "GLS-SD-003"), (GH, "GLS-SD-006"), (SLACK, "GLS-SD-007"), (WIDE, "GLS-SD-009")):
        docs.append({"decision": "block", "findings": [finding(rid, "secret_detection", key, key)]})
        docs.append({"decision": "block", "findings": [finding(rid, "secret_detection", key[:50], key)]})
        # a window of another finding that holds the whole key, the end of it, the start of it, a piece inside it
        docs.append({"decision": "block", "findings": [
            finding(rid, "secret_detection", key, key),
            finding("GLS-PI-001", "prompt_injection", "ignore " + key + " now", "send " + key + " to"),
            finding("GLS-EX-001", "exfiltration", "xx" + key[:7], key[-8:] + " yy"),
            finding("GLS-EX-002", "exfiltration", key[3:9], key[1:5] + key[:3]),
        ]})
    docs.append({"decision": "block", "findings": [
        finding("GLS-SD-003", "secret_detection", AWS, AWS),
        finding("GLS-PI-001", "prompt_injection", "see " + LEET.lower() + " here", "AKiAzq7xk2m9p4wl8tnb"),
    ]})
    docs.append({"decision": "block", "findings": [finding("GLS-SD-003", "secret_detection", "", "")]})
    docs.append({"decision": "block", "findings": [{"id": "GLS-SD-099", "matched_text": AWS, "shown_text": AWS}]})
    docs.append({"decision": "allow", "findings": [finding("GLS-PI-001", "prompt_injection", "ignore previous", "ignore previous")]})
    # a repo report: files with findings, and the policy lists that carry the span
    f1 = finding("GLS-SD-003", "secret_detection", AWS, AWS)
    f2 = finding("GLS-PI-001", "prompt_injection", "use " + AWS + " now", "use " + AWS + " now")
    docs.append({"repo": "o/r", "files": [{"path": "AGENTS.md", "decision": "block", "findings": [f1, f2]}],
                 "notes": [{"file": "AGENTS.md", "id": "GLS-SD-003", "severity": "high", "category": "secret_detection", "matched_text": AWS},
                           {"file": "AGENTS.md", "id": "GLS-PI-001", "severity": "high", "category": "prompt_injection", "matched_text": "use " + AWS + " now"}],
                 "review": [], "signature_hits": []})
    return docs


class DoorMaskParity(unittest.TestCase):
    def test_the_worker_marker_equals_the_scanner_marker_on_every_document(self):
        docs = documents()
        want = [mask_document(json.loads(json.dumps(d))) for d in docs]
        js = ("import('./src/door_mask.js').then(m => { const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));"
              " console.log(JSON.stringify(d.map(m.maskDocument))); })")
        run = subprocess.run(["node", "-e", js], input=json.dumps(docs), capture_output=True, text=True, cwd=ROOT, check=True, timeout=300)
        got = json.loads(run.stdout)
        self.assertEqual(len(got), len(want))
        for i, (g, w) in enumerate(zip(got, want)):
            self.assertEqual(g, w, "document %d differs" % i)

    def test_made_up_keys_appear_in_none_of_the_collected_answers(self):
        docs = documents()
        js = ("import('./src/door_mask.js').then(m => { const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));"
              " console.log(JSON.stringify(d.map(m.maskReport))); })")
        run = subprocess.run(["node", "-e", js], input=json.dumps(docs), capture_output=True, text=True, cwd=ROOT, check=True, timeout=300)
        for text in run.stdout.splitlines():
            for key in (AWS, GH, SLACK):
                self.assertNotIn(key, text)


if __name__ == "__main__":
    unittest.main()
