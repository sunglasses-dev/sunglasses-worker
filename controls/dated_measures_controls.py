#!/usr/bin/env python3
"""CONTROLS for dated_measures.py: each outcome of the check, seen before the check is believed.

Usage: python3 controls/dated_measures_controls.py

  cases 1, 2     a measure older than the set                 exit 1, the entry is named
  case 3          a measure on the day of the set              exit 0, said to be the same day
  case 4          a measure after the set                      exit 0
  case 5          a file with no dated measure                 exit 2, never a pass
  case 6          a mix of older and newer                     exit 1, only the older one is named
  case 7          today's /about text against a set made after its measures   exit 1, every dated entry named
"""
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHECK = os.path.join(ROOT, "dated_measures.py")


def entry(label, date):
    return '  "%s. Reach is small. Measured on %s beside the pip scanner on 10 probe rows, 0 answer lower",\n' % (label, date)


def run(text, set_date):
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf8") as f:
        f.write("export const LIMITATIONS = [\n" + text + "];\n")
        name = f.name
    try:
        r = subprocess.run([sys.executable, CHECK, name, set_date], capture_output=True, text=True)
        return r.returncode, r.stdout + r.stderr
    finally:
        os.unlink(name)


def main():
    bad = 0

    def row(label, rc, out, want_rc, must=(), must_not=()):
        nonlocal bad
        ok = rc == want_rc and all(w in out for w in must) and not any(w in out for w in must_not)
        bad += 0 if ok else 1
        print("  %-5s %-70s exit %d (want %d)" % ("OK" if ok else "WRONG", label, rc, want_rc))
        if not ok:
            print("        " + out.strip().replace("\n", "\n        ")[-400:])

    rc, out = run(entry("Alpha", "19 November 2026"), "2026-11-20")
    row("red: one measure a day older than the set", rc, out, 1, ("Alpha", "OLDER than the set"))
    rc, out = run(entry("Alpha", "3 March 2026"), "2026-11-20")
    row("red: one measure months older (single digit day parses)", rc, out, 1, ("Alpha", "OLDER than the set"))
    rc, out = run(entry("Alpha", "20 November 2026"), "2026-11-20")
    row("green: a measure on the day of the set, said to be the same day", rc, out, 0, ("same day as the set",))
    rc, out = run(entry("Alpha", "21 November 2026"), "2026-11-20")
    row("green: a measure after the set", rc, out, 0, ("after the set",))
    rc, out = run('  "Alpha. Nothing here carries a date",\n', "2026-11-20")
    row("red: no dated measure in the file is never a pass", rc, out, 2, ("NO DATED MEASURE FOUND",))
    rc, out = run(entry("Alpha", "19 November 2026") + entry("Beta", "21 November 2026"), "2026-11-20")
    row("red: a mix, only the older one is named as older", rc, out, 1, ("1 of 2 measure(s) older",))
    real = os.path.join(ROOT, "src", "preprocessor.js")
    r = subprocess.run([sys.executable, CHECK, real, "2099-01-01"], capture_output=True, text=True)
    sys.path.insert(0, ROOT)
    import dated_measures
    n = len(dated_measures.measures(open(real, encoding="utf8").read()))
    row("red: today's /about text against a set made in 2099", r.returncode, r.stdout, 1, ("%d of %d measure(s) older" % (n, n),))
    print("  DATED MEASURE CONTROLS %s" % ("OK" if not bad else "FAILED (%d wrong)" % bad))
    sys.exit(1 if bad else 0)


main()
