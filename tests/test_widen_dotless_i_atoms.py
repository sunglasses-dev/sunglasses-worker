"""The dotless i widening reads a character class as atoms, and a range is one atom.

A range such as `[\\x69-z]` was widened by putting the two dotless code points straight after the
escaped low end, so the last of them became the new low end: a syntax failure, a missed match, or an
extra match in a negated class. The widening now decides on whole atoms (a literal, an escape, a
range) and writes the two code points after the atom, never inside it. The octal and eight digit
Unicode spellings, which Python reads and JavaScript does not, are written as the same code point.

Run with python3 -m unittest tests/test_widen_dotless_i_atoms.py from the Worker folder.
"""
import itertools
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
import warnings

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import compile_patterns as cp  # noqa: E402

TEXTS = ["i", "I", "\u0130", "\u0131", "a", "h", "H", "j", "J", "z", "A", "Z", "k", "-", " "]


def node_batch(cases):
    """[(source, flags, text)] -> list of True / False, or the error text for a source node rejects."""
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(cases, f)
        path = f.name
    try:
        js = ("const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));"
              "console.log(JSON.stringify(c.map(([s,f,t])=>{try{return new RegExp(s,f).test(t)}"
              "catch(e){return 'ERR '+e.message}})))")
        out = subprocess.run(["node", "-e", js, path], capture_output=True, text=True, check=True)
        return json.loads(out.stdout)
    finally:
        os.unlink(path)


def disagreements(sources):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")  # Python warns about `--` as a future set difference
        return _disagreements(sources)


def _disagreements(sources):
    """Every (source, text) where Python's case-insensitive match and the emitted JavaScript differ,
    and every emitted source that JavaScript does not accept."""
    cases, wanted = [], []
    for source in sources:
        widened = cp._widen_dotless_i(source)
        for text in TEXTS:
            cases.append([widened, "iu", text])
            wanted.append((source, widened, text, re.search(source, text, re.IGNORECASE) is not None))
    got = node_batch(cases)
    return [(s, w, t, e, g) for (s, w, t, e), g in zip(wanted, got) if g != e]


ENDPOINTS = [r"\x69", r"\x49", r"\u0069", r"\u0049", "a", "h", r"\x68", r"\x61", "z", r"\x7a",
             "A", r"\x41", "Z", r"\x5a"]


def _compiles(source):
    try:
        re.compile(source)
        return True
    except re.error:
        return False


RANGES = [f"{lo}-{hi}" for lo, hi in itertools.product(ENDPOINTS, repeat=2)
          if _compiles(f"[{lo}-{hi}]")]


class RangeEndpoints(unittest.TestCase):
    def test_the_reported_ranges_match_what_python_matches(self):
        sources = [r"[\x69-z]", r"[\x49-z]", r"[\u0069-z]", r"[a-\x69]", r"[\x61-\x69]", r"[\x41-\x5a]",
                   r"[\x69-\x69]", r"[\x00-\x7f]"]
        self.assertEqual(disagreements(sources + ["[^" + s[1:] for s in sources]), [])

    def test_every_range_of_every_endpoint_spelling_matches_what_python_matches(self):
        sources = ["[" + r + "]" for r in RANGES] + ["[^" + r + "]" for r in RANGES]
        self.assertGreater(len(sources), 200)
        self.assertEqual(disagreements(sources), [])

    def test_a_range_is_kept_whole_and_the_two_code_points_follow_it(self):
        out = cp._widen_dotless_i(r"[\x69-z]")
        self.assertEqual(out, r"[\x69-z" + cp.DOTLESS_I + "]")
        self.assertEqual(cp._widen_dotless_i(r"[a-\x69]"), r"[a-\x69" + cp.DOTLESS_I + "]")

    def test_a_range_that_does_not_reach_i_is_left_alone(self):
        for source in (r"[a-\x68]", r"[\x61-h]", r"[j-\x7a]", r"[^\x6a-z]"):
            self.assertEqual(cp._widen_dotless_i(source), source)

    def test_a_hyphen_after_a_widened_atom_cannot_start_a_new_range(self):
        sources = [r"[a-z-9]", r"[a-z--9]", r"[i-9]", r"[a-z-]", r"[ai-]", r"[a-z\d-9]"]
        self.assertEqual(disagreements([x for x in sources if _compiles(x)]), [])
        self.assertEqual(cp._widen_dotless_i("[a-z-9]"), "[a-z" + cp.DOTLESS_I + r"\-9]")
        # a hyphen that closes the class is a literal in both engines and is left as it was
        self.assertEqual(cp._widen_dotless_i("[a-z-]"), "[a-z" + cp.DOTLESS_I + "-]")

    def test_a_class_escape_is_not_a_range_endpoint(self):
        self.assertEqual(cp._widen_dotless_i(r"[\d-z]"), r"[\d-z]")

    def test_classes_made_of_several_atoms_match_what_python_matches(self):
        atoms = [r"\x69", "a", "h", r"\151", "i", "I", r"\x49-\x5a", r"\x69-z", "a-\\x69", r"\d", "-"]
        sources = []
        for n in (1, 2, 3):
            for combo in itertools.product(atoms, repeat=n):
                body = "".join(combo)
                for source in ("[" + body + "]", "[^" + body + "]"):
                    if _compiles(source):
                        sources.append(source)
        self.assertGreater(len(sources), 500)
        self.assertEqual(disagreements(sources[::3]), [])


class SpellingsPythonReadsAndJavaScriptDoesNot(unittest.TestCase):
    def test_an_octal_escape_is_written_as_the_same_code_point(self):
        self.assertEqual(cp._widen_dotless_i(r"\141"), r"\x61")
        self.assertEqual(cp._widen_dotless_i(r"[\141]"), r"[\x61]")

    def test_an_octal_or_long_unicode_spelling_of_i_is_widened_like_the_letter(self):
        for source in (r"\151", r"\111", r"[\151a]", r"[^\111a]", r"\U00000069", r"[\U00000049a]",
                       r"[\151-z]", r"[a-\U00000069]"):
            with self.subTest(source=source):
                self.assertEqual(disagreements([source]), [])

    def test_a_long_unicode_escape_becomes_a_code_point_escape(self):
        self.assertEqual(cp._widen_dotless_i(r"\U0001f600"), r"\u{1f600}")

    def test_a_backreference_is_not_an_octal_escape(self):
        self.assertEqual(cp._widen_dotless_i(r"(a)\1"), r"(a)\1")

    def test_an_octal_escape_in_an_exact_case_group_is_converted_and_not_widened(self):
        self.assertEqual(cp._widen_dotless_i(r"(?-i:\151)"), r"(?-i:\x69)")


if __name__ == "__main__":
    unittest.main()
