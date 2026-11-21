#!/usr/bin/env python3
"""CONTROLS for the derived `floor` key of gate (c): each refusal seen red before the green is believed.

Usage: python3 controls/floor_contract_controls.py <scanner checkout of the tag> <compiled src/patterns.js> [old_gate.py]

The compiled artefact is read, changed in memory the way a wrong compiler would change it, written to a
scratch file and given to the gate in a scratch copy of the worker tree. Every row states the exit code it
must produce and the words it must print. The gate is only ever given a file on disk.

  green    the artefact as compiled, written back unchanged                       exit 0
  red      one compiled record loses its floor                                    exit 1  floor LOST
  red      a rule with no twin gets a floor                                       exit 1  floor INVENTED
  red      a rule on the quiet list gets a floor                                  exit 1  floor INVENTED
  red      the floor of one rule moves to another rule (same count, other ids)    exit 1  LOST and INVENTED
  red      one entry of one floor is dropped                                      exit 1  floor has
  red      one floor gains an entry                                               exit 1  floor has
  red      a floor that is not an object with a regex list                        exit 1  floor is not
  red      the contract has no derived bucket (contract_version 1)                exit 1  no `derived` bucket
  red      the contract has a derived bucket with no floor row                    exit 1  no `floor` row
  red      the OLD gate, on the artefact as compiled (the refusal of the 0.6.25 recompile)   exit 1   (optional)
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    scanner = os.path.abspath(sys.argv[1])
    artefact = os.path.abspath(sys.argv[2])
    old_gate = os.path.abspath(sys.argv[3]) if len(sys.argv) > 3 else None
    work = tempfile.mkdtemp(prefix="floor_controls_")
    try:
        run(scanner, artefact, old_gate, work)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def run(scanner, artefact, old_gate, work):
    for f in ("_source_parity.py", "_dump_compiled.mjs", "pattern_field_contract.json"):
        shutil.copy(os.path.join(ROOT, f), os.path.join(work, f))
    dump = subprocess.run(["node", os.path.join(work, "_dump_compiled.mjs"), artefact], capture_output=True, text=True)
    if dump.returncode != 0:
        print("  cannot read the artefact:", dump.stderr[:300]); sys.exit(2)
    base = json.loads(dump.stdout)
    sys.path.insert(0, scanner)
    from sunglasses.patterns import PATTERNS
    from sunglasses.engine import _guard_floor_twin
    from sunglasses._floor_quiet import FLOOR_QUIET_IDS
    twin = {p["id"]: _guard_floor_twin(p) is not None for p in PATTERNS}
    quiet = set(FLOOR_QUIET_IDS)

    def write(doc, name):
        path = os.path.join(work, name)
        with open(path, "w") as f:
            f.write("export const PATTERNS_VERSION = %s;\n" % json.dumps(doc["patterns_version"]))
            f.write("export const COMPILED_FROM = %s;\n" % json.dumps(doc["compiled_from"]))
            f.write("export const PATTERNS = %s;\n" % json.dumps(doc["patterns"], separators=(",", ":")))
        return path

    def gate(path, gate_file="_source_parity.py", contract=None):
        env = dict(os.environ, SG_SCANNER_ROOT=scanner, SUNGLASSES_SRC=scanner)
        if contract is not None:
            with open(os.path.join(work, "pattern_field_contract.json"), "w") as f:
                json.dump(contract, f)
        r = subprocess.run([sys.executable, os.path.join(work, gate_file), path], capture_output=True, text=True, env=env)
        if contract is not None:
            shutil.copy(os.path.join(ROOT, "pattern_field_contract.json"), os.path.join(work, "pattern_field_contract.json"))
        return r.returncode, r.stdout + r.stderr

    def fresh():
        return json.loads(dump.stdout)

    with_floor = sorted(c["id"] for c in base["patterns"] if "floor" in c)
    no_floor = sorted(c["id"] for c in base["patterns"] if "floor" not in c)
    no_twin = [i for i in no_floor if not twin.get(i)]
    quiet_twin = [i for i in no_floor if i in quiet and twin.get(i)]
    wide = [i for i in with_floor if len(next(c for c in base["patterns"] if c["id"] == i)["floor"]["regex"]) >= 2]
    if not (with_floor and no_twin and quiet_twin):
        print("  the artefact does not hold the shapes these controls need (floors, a rule with no twin, a quiet rule with a twin)")
        sys.exit(2)

    def by(doc, rid):
        return next(c for c in doc["patterns"] if c["id"] == rid)

    rows = []

    def lose():
        d = fresh(); del by(d, with_floor[0])["floor"]; return d, "floor LOST"

    def invent_no_twin():
        d = fresh(); by(d, no_twin[0])["floor"] = json.loads(json.dumps(by(d, with_floor[0])["floor"])); return d, "floor INVENTED"

    def invent_quiet():
        d = fresh(); by(d, quiet_twin[0])["floor"] = json.loads(json.dumps(by(d, with_floor[0])["floor"])); return d, "floor INVENTED"

    def move():
        d = fresh()
        f = by(d, with_floor[0])["floor"]; del by(d, with_floor[0])["floor"]
        by(d, no_twin[0])["floor"] = f
        return d, "floor LOST"

    def drop():
        d = fresh(); rid = (wide or with_floor)[0]; f = by(d, rid)["floor"]; f["regex"] = f["regex"][:-1]; return d, "floor has"

    def add():
        d = fresh(); f = by(d, with_floor[0])["floor"]; f["regex"] = f["regex"] + [f["regex"][-1]]; return d, "floor has"

    def malformed():
        d = fresh(); by(d, with_floor[0])["floor"] = "not an object"; return d, "floor is not"

    print("  floor contract controls  (%d floors, %d rules with no twin, %d quiet rules with a twin in the artefact)"
          % (len(with_floor), len(no_twin), len(quiet_twin)))
    bad = 0

    def row(label, rc, out, want_rc, want_words=()):
        nonlocal bad
        ok = rc == want_rc and all(w in out for w in want_words)
        bad += 0 if ok else 1
        print("  %-5s %-72s exit %d (want %d)" % ("OK" if ok else "WRONG", label, rc, want_rc))
        if not ok:
            print("        " + out.strip().replace("\n", "\n        ")[-500:])

    rc, out = gate(write(fresh(), "green.js"))
    row("green: the artefact as compiled, written back unchanged", rc, out, 0, ("derived floor equals",))
    for label, make in (("red: one compiled record loses its floor", lose),
                        ("red: a rule with no twin gets a floor", invent_no_twin),
                        ("red: a rule on the quiet list gets a floor", invent_quiet),
                        ("red: the floor of one rule moves to a rule with no twin", move),
                        ("red: one entry of one floor is dropped", drop),
                        ("red: one floor gains an entry", add),
                        ("red: a floor that is not an object with a regex list", malformed)):
        doc, words = make()
        rc, out = gate(write(doc, "mutant.js"))
        row(label, rc, out, 1, (words,))
    with open(os.path.join(ROOT, "pattern_field_contract.json")) as f:
        contract = json.load(f)
    v1 = {k: v for k, v in contract.items() if k != "derived"}; v1["contract_version"] = 1
    rc, out = gate(write(fresh(), "green.js"), contract=v1)
    row("red: the contract has no derived bucket (contract_version 1)", rc, out, 1, ("no `derived` bucket",))
    nofloor = json.loads(json.dumps(contract)); del nofloor["derived"]["floor"]
    rc, out = gate(write(fresh(), "green.js"), contract=nofloor)
    row("red: the contract has a derived bucket with no floor row", rc, out, 1, ("no `floor` row",))
    if old_gate:
        shutil.copy(old_gate, os.path.join(work, "_old_gate.py"))
        rc, out = gate(write(fresh(), "green.js"), gate_file="_old_gate.py", contract=v1)
        row("the OLD gate and the OLD contract on the artefact as compiled (what refused the recompile)", rc, out, 1, ("floor",))
    print("  FLOOR CONTROLS %s" % ("OK" if not bad else "FAILED (%d wrong)" % bad))
    sys.exit(1 if bad else 0)


main()
