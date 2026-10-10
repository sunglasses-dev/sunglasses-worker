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
import unicodedata
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import compile_patterns as cp  # noqa: E402
from test_widen_dotless_i_atoms import _compiles, disagreements  # noqa: E402

# The four members and every spelling of each that the escape reader accepts. The escapes are built
# from the code point, so no spelling can silently be written twice.
def _spellings(cp):
    out = [chr(cp), "\\x%02x" % cp if cp < 256 else None, "\\u%04x" % cp, "\\U%08x" % cp,
           "\\N{%s}" % unicodedata.name(chr(cp)), "\\%o" % cp if cp <= 0o377 else None]
    return [s for s in out if s is not None]


MEMBERS = {name: _spellings(cp) for name, cp in
           (("I", 0x49), ("i", 0x69), ("dotted", 0x130), ("dotless", 0x131))}
# The reader also accepts a backslash before a non-ASCII member. JavaScript rejects that spelling in
# the emitted regex (an inherited fault, disclosed, not changed here), so it is kept apart.
IDENTITY = ["\\" + chr(0x130), "\\" + chr(0x131)]
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

    def test_case_scopes_agree_in_both_engines(self):
        # Python and this Node both read (?-i: and (?i: as scopes, so the converter's output is
        # compared with Python's match and not only with a string.
        sources = []
        for s in ("İ", "ı", "i", "\\x69", "\\u0130", "\\u0131"):
            sources += [f"(?-i:{s})", f"(?-i:[{s}])", f"(?-i:[^{s}])", f"(?-i:a(?i:{s}))",
                        f"(?i:(?-i:{s}))", f"(?-i:a)(?i:{s})"]
        sources = [x for x in sources if _compiles(x)]
        self.assertGreater(len(sources), 30)
        self.assertEqual(disagreements(sources), [])

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


class AsciiModeIsRefused(unittest.TestCase):
    """Python's ASCII mode makes U+0130 and U+0131 exact characters even when case does not matter,
    so the four-member rule holds only in Unicode mode. Nothing shipped uses the mode, so it is
    refused with an error and not translated."""

    def test_python_does_not_fold_the_non_ascii_members_in_ascii_mode(self):
        self.assertIsNotNone(re.search("\u0131", "i", re.IGNORECASE))
        self.assertIsNone(re.search("\u0131", "i", re.IGNORECASE | re.ASCII))
        self.assertIsNone(re.search("(?a)(?i)\u0130", "i"))

    def test_a_leading_ascii_flag_is_refused(self):
        for source in ("(?a)i", "(?a)\u0131", "(?ai)\u0130", "(?ia)[\u0131]", "(?a)(?i)x", "(?i)(?a)x",
                       "(?ma)x", "(?as)x"):
            with self.subTest(source=source), self.assertRaisesRegex(ValueError, "ASCII"):
                cp.convert(source)

    def test_a_scoped_ascii_group_is_refused(self):
        for source in ("(?a:i)", "(?ai:\u0131)", "x(?a:[\u0130])", "(?i:(?a:x))", "(?s-i:(?a:x))"):
            with self.subTest(source=source), self.assertRaisesRegex(ValueError, "ASCII"):
                cp.convert(source)

    def test_the_widening_itself_refuses_a_scoped_ascii_group(self):
        with self.assertRaisesRegex(ValueError, "ASCII"):
            cp._widen_dotless_i("(?a:\u0131)")

    def test_an_escaped_parenthesis_and_a_letter_a_are_not_the_flag(self):
        for source in ("\\(?a:x", "[(]a", "(?i)a", "(?:a)", "(?P<a>x)"):
            with self.subTest(source=source):
                cp.convert(source)

    def test_the_other_leading_flags_are_still_read(self):
        self.assertEqual(cp.convert("(?s)x")[1], "isu")
        self.assertEqual(cp.convert("(?u)x")[1], "iu")


class SpellingsAreDistinctAndComplete(unittest.TestCase):
    def test_no_member_is_listed_twice(self):
        self.assertEqual(len(ALL), len(set(ALL)))
        self.assertEqual(sorted(MEMBERS["dotted"]), sorted(set(MEMBERS["dotted"])))
        self.assertTrue(any(s.startswith("\\u0130") for s in MEMBERS["dotted"]))
        self.assertTrue(any(s.startswith("\\u0131") for s in MEMBERS["dotless"]))
        self.assertTrue(any(s.startswith("\\u0049") for s in MEMBERS["I"]))

    def test_identity_escapes_are_a_disclosed_syntax_failure_not_a_widening_mistake(self):
        rows = disagreements([x for x in IDENTITY + ["[" + y + "]" for y in IDENTITY] if _compiles(x)])
        self.assertTrue(rows)
        self.assertTrue(all(isinstance(got, str) and got.startswith("ERR") for *_, got in rows), rows[:3])
