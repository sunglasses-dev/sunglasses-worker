#!/usr/bin/env python3
"""Which dated measures in the Worker's /about text are older than the rule set that was just compiled.

Usage: python3 dated_measures.py <src/preprocessor.js> <set-date YYYY-MM-DD>

The /about limitations carry sentences of the form "Measured on 19 November 2026 beside the pip scanner on N probe
rows, ...". A recompile changes the rule set under them. A measure dated before the compiled set was made describes
the previous set, so it is listed here for re-measuring before anything is published.

The set date is the date of the tagged source commit the recompile read. Exit 0 when every measure is on or after
that date, 1 when at least one is older, 2 when the file carries no dated measure at all (the sentence changed shape
and this check read nothing, which is reported and never taken as a pass).
"""
import datetime
import re
import sys

MONTHS = {m: i for i, m in enumerate(
    ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November",
     "December"], 1)}
ENTRY = re.compile(r'^\s*"((?:[^"\\]|\\.)*)",?\s*$')
MEASURE = re.compile(r"Measured on (\d{1,2}) ([A-Z][a-z]+) (\d{4})")


def measures(text):
    found = []
    for line in text.splitlines():
        m = ENTRY.match(line)
        if not m:
            continue
        entry = m.group(1)
        for d in MEASURE.finditer(entry):
            month = MONTHS.get(d.group(2))
            if month is None:
                continue
            label = entry.split(".")[0][:60]
            found.append((label, datetime.date(int(d.group(3)), month, int(d.group(1)))))
    return found


def main(argv):
    if len(argv) != 3:
        print(__doc__)
        return 2
    set_date = datetime.date.fromisoformat(argv[2])
    found = measures(open(argv[1], encoding="utf8").read())
    if not found:
        print("  NO DATED MEASURE FOUND in %s: the sentence changed shape, so this check saw nothing" % argv[1])
        return 2
    older = [(label, d) for label, d in found if d < set_date]
    same = [(label, d) for label, d in found if d == set_date]
    print("  dated measures: %d, compiled set made %s" % (len(found), set_date.isoformat()))
    for label, d in found:
        state = "OLDER than the set, re-measure" if d < set_date else ("same day as the set" if d == set_date else "after the set")
        print("    %-34s measured %s  %s" % (label, d.isoformat(), state))
    if same:
        print("  %d measure(s) carry the same day as the set: the date cannot show which came first, read the run time" % len(same))
    print("  %d of %d measure(s) older than the compiled set" % (len(older), len(found)))
    return 1 if older else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
