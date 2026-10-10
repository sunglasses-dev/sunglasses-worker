"""Every member of Python's case equivalence class of the letter i is widened, in every spelling.

Python, with re.IGNORECASE, treats four code points as one letter: I, i, U+0130 (dotted capital I)
and U+0131 (dotless i). JavaScript with `iu` folds only I and i. The widening used to decide on the
two ASCII members, so a pattern that names U+0130 or U+0131 (as a character, a `\\u0130` escape, a
`\\U00000130` escape or a `\\N{...}` name) was copied through unchanged: the positive pattern then
missed texts Python matches and the negated class matched texts Python excludes. These spellings
were syntax failures before the escape reader accepted them, so the hole was only visible after it.

The widening now asks one question of every decoded atom and every decoded range: does it hold any
of the four code points? If it does, the class carries all four. Nothing here depends on how the
atom was spelled, so a spelling that is not listed below is decided the same way.

Run with python3 -m unittest tests/test_widen_dotless_i_equivalents.py from the Worker folder.
"""
import itertools
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import compile_patterns as cp  # noqa: E402
from test_widen_dotless_i_atoms import _compiles, disagreements  # noqa: E402

# The four members and every spelling of each that the escape reader accepts.
MEMBERS = {
    "I": ["I", r"\x49", r"I", r"\111", r"\U00000049", r"\N{LATIN CAPITAL LETTER I}"],
    "i": ["i", r"\x69", r"i", r"\151", r"\U00000069", r"\N{LATIN SMALL LETTER I}"],
    "dotted": ["İ", r"İ", r"\U00000130", r"\N{LATIN CAPITAL LETTER I WITH DOT ABOVE}"],
    "dotless": ["ı", r"ı", r"\U00000131", r"\N{LATIN SMALL LETTER DOTLESS I}"],
}
ALL = [s for spellings in MEMBERS.values() for s in spellings]
# Neighbours of the four, so a range can end next to them, reach one of them from outside, or miss.
NEIGHBOURS = ["h", "j", "H", "J", r"\x68", r"į", "Ĳ", r"Ā", r"ſ", "a", "z"]


class EveryMemberIsDecidedTheSameWay(unittest.TestCase):
    def test_a_single_member_outside_a_class(self):
        self.assertEqual(disagreements([s for s in ALL if _compiles(s)]), [])

    def test_a_single_member_in_a_positive_and_a_negated_class(self):
        sources = []
        for s in ALL:
            sources += ["[" + s + "]", "[^" + s + "]", "[a" + s + "]", "[^a" + s + "]",
                        "[" + s + "z]", "[^" + s + "z]", "[a" + s + "z]"]
        self.assertEqual(disagreements([x for x in sources if _compiles(x)]), [])

    def test_a_range_with_a_member_or_a_neighbour_at_either_end(self):
        ends = ALL + NEIGHBOURS
        sources = []
        for lo, hi in itertools.product(ends, repeat=2):
            for body in (lo + "-" + hi,):
                sources += ["[" + body + "]", "[^" + body + "]"]
        sources = [x for x in sources if _compiles(x)]
        self.assertGreater(len(sources), 500)
        self.assertEqual(disagreements(sources), [])

    def test_a_range_made_only_of_the_two_non_ascii_members_still_matches_the_ascii_ones(self):
        # Python: [İ-ı] with IGNORECASE matches i and I; JavaScript's iu needs `i` named.
        for source in (r"[İ-ı]", r"[^İ-ı]", "[İ-ı]", r"[ı-ı]",
                       r"[\U00000130-\U00000131]"):
            with self.subTest(source=source):
                self.assertEqual(disagreements([source]), [])

    def test_two_members_in_one_class_and_a_member_beside_a_hyphen(self):
        sources = []
        for a, b in itertools.product(ALL[::2], repeat=2):
            sources += ["[" + a + b + "]", "[^" + a + b + "]", "[" + a + "-" + b + "]"]
        sources += ["[İ-9]", "[ı-9]", "[a-zİ-]", "[İ-]", "[-ı]"]
        self.assertEqual(disagreements([x for x in sources if _compiles(x)]), [])

    def test_a_member_inside_a_group_that_matches_exact_case_is_left_alone(self):
        for s in ("İ", r"İ", "ı", r"ı", "i", r"\x69"):
            for source in (f"(?-i:{s})", f"(?-i:[{s}])", f"(?-i:[^{s}])", f"(?-i:[a-{s}])"):
                if not _compiles(source):
                    continue
                with self.subTest(source=source):
                    self.assertEqual(cp._widen_dotless_i(source), source)

    def test_a_member_in_a_group_that_turns_case_back_on_is_widened(self):
        for s in ("İ", r"ı", r"\N{LATIN CAPITAL LETTER I WITH DOT ABOVE}"):
            source = f"(?-i:a(?i:{s}))"
            with self.subTest(source=source):
                widened = cp._widen_dotless_i(source)
                self.assertIn("[i" + cp.DOTLESS_I + "]", widened)

    def test_the_widened_form_of_a_non_ascii_member_names_all_four(self):
        for s in MEMBERS["dotted"] + MEMBERS["dotless"]:
            with self.subTest(source=s):
                widened = cp._widen_dotless_i(s)
                self.assertEqual(widened, "[i" + cp.DOTLESS_I + "]")
        self.assertEqual(cp._widen_dotless_i("[" + MEMBERS["dotted"][1] + "]"),
                         "[" + MEMBERS["dotted"][1] + "i" + cp.DOTLESS_I + "]")

    def test_nothing_that_is_not_a_member_changes(self):
        for source in (r"Ĳ", r"[Ĳ-ĳ]", r"[^į]", "é", r"[Ā-į]",
                       r"[Ĳ-ſ]"):
            with self.subTest(source=source):
                self.assertEqual(cp._widen_dotless_i(source), source)


if __name__ == "__main__":
    unittest.main()
