"""The Worker's channel alias table is the scanner's, key for key.

CHANNEL_ALIASES in src/engine.js is a port of the scanner's table. A typed copy drifts: a line the
scanner gains and the Worker does not makes the hosted scan answer below the pip scanner on that
channel. This test reads the table of the pinned scanner by code (the installed package, or the
source tree named in SUNGLASSES_SRC) and the table of src/engine.js by code, and compares them.

Run with python3 -m unittest tests/test_channel_alias_table.py from the Worker folder.
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
from sunglasses.engine import SunglassesEngine  # noqa: E402

JS = "import('./src/engine.js').then(m => console.log(JSON.stringify(m.CHANNEL_ALIASES)))"


def worker_table():
    out = subprocess.run(["node", "-e", JS], capture_output=True, text=True, cwd=ROOT, check=True, timeout=300)
    return json.loads(out.stdout)


class ChannelAliasTable(unittest.TestCase):
    def test_the_worker_table_equals_the_scanner_table_key_for_key(self):
        scanner, worker = dict(SunglassesEngine.CHANNEL_ALIASES), worker_table()
        self.assertEqual(sorted(scanner), sorted(worker),
                         "only-scanner: %s, only-worker: %s" % (sorted(set(scanner) - set(worker)), sorted(set(worker) - set(scanner))))
        self.assertEqual({k: v for k, v in scanner.items() if worker[k] != v}, {},
                         "a channel the Worker maps to a different channel than the scanner does")

    def test_the_comparison_reads_a_removed_line(self):
        scanner = dict(SunglassesEngine.CHANNEL_ALIASES)
        scanner.pop(next(iter(scanner)))
        self.assertNotEqual(sorted(scanner), sorted(worker_table()))


if __name__ == "__main__":
    unittest.main()
