"""The dotless i widening reads a character class as a class, and orders anchors the same way every build.

A group modifier is not recognised inside a class: `[(?-i:]` is five literal characters, and a literal
i among them must still match U+0130 and U+0131 the way Python's case-insensitive class does, or be
excluded from a negated class. An escaped spelling of the letter (`\\x69`, `\\u0069`) is widened like
the letter itself, and a closing bracket that comes first in a class is a literal.

Run with python3 -m unittest tests/test_widen_dotless_i_classes.py from the Worker folder.
"""
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import compile_patterns as cp  # noqa: E402
from test_widen_dotless_i_scope import node_test  # noqa: E402

TEXTS = ["\u0130", "\u0131", "i", "I", "a", "(", "?", "-", ":", "]", "b", "<", ">", "P"]


def python_matches(source, text):
    return re.search(source, text, re.IGNORECASE) is not None


def disagreements(source):
    widened = cp._widen_dotless_i(source)
    return [t for t in TEXTS
            if python_matches(source, t) != node_test(widened, "iu", t)]


POSITIVE_CLASSES = ["[(?-i:]", "[(?-i:a]", "[(?i:]", "[(?P<i>]", "[(?-i)]", "[(?<n>i]"]
NEGATED_CLASSES = ["[^(?-i:]", "[^(?-i:a]", "[^(?i:]", "[^(?P<i>]", "[^(?-i)]"]


class ModifiersInsideClasses(unittest.TestCase):
    def test_a_positive_class_that_spells_a_modifier_matches_what_python_matches(self):
        for source in POSITIVE_CLASSES:
            with self.subTest(source=source):
                self.assertEqual(disagreements(source), [])

    def test_a_negated_class_that_spells_a_modifier_excludes_what_python_excludes(self):
        for source in NEGATED_CLASSES:
            with self.subTest(source=source):
                self.assertEqual(disagreements(source), [])

    def test_the_letter_in_a_class_spelled_like_a_modifier_is_widened(self):
        self.assertIn("\u0130\u0131", cp._widen_dotless_i("[(?-i:]"))

    def test_a_real_modifier_outside_a_class_is_still_copied_through(self):
        self.assertEqual(cp._widen_dotless_i("(?-i:i)"), "(?-i:i)")
        self.assertEqual(cp._widen_dotless_i("(?i:x)"), "(?i:x)")

    def test_a_class_after_a_real_modifier_keeps_its_scope(self):
        self.assertEqual(cp._widen_dotless_i("(?-i:[(?-i:])"), "(?-i:[(?-i:])")


class EscapedSpellingsOfTheLetter(unittest.TestCase):
    SOURCES = [r"\x69", r"\x49", r"\u0069", r"\u0049", r"[\x69a]", r"[\u0049a]",
               r"[^\x69a]", r"[^\u0069a]"]

    def test_an_escaped_i_matches_what_python_matches(self):
        for source in self.SOURCES:
            with self.subTest(source=source):
                self.assertEqual(disagreements(source), [])

    def test_an_escaped_i_in_an_exact_case_group_is_left_alone(self):
        self.assertEqual(cp._widen_dotless_i(r"(?-i:\x69)"), r"(?-i:\x69)")

    def test_an_escaped_letter_that_is_not_i_is_left_alone(self):
        self.assertEqual(cp._widen_dotless_i(r"\x41\u0042"), r"\x41\u0042")


class LeadingClosingBracket(unittest.TestCase):
    SOURCES = ["[]a]", "[]i]", "[^]a]", "[^]i]", "[]]"]

    def test_a_closing_bracket_that_comes_first_is_a_member_of_the_class(self):
        for source in self.SOURCES:
            with self.subTest(source=source):
                self.assertEqual(disagreements(source), [])

    def test_the_class_ends_at_the_next_closing_bracket(self):
        self.assertEqual(disagreements("[]a]b"), [])
        self.assertEqual(cp._widen_dotless_i("[]a]i"), "[\\]a]" + cp._widen_dotless_i("i"))


class AnchorOrder(unittest.TestCase):
    def test_equal_length_anchors_are_ordered_lexically(self):
        self.assertEqual(cp._order_anchors({"cd", "ab", "e", "fg"}), ["ab", "cd", "fg", "e"])

    def test_the_order_does_not_depend_on_how_the_set_was_built(self):
        terms = ["zz", "aa", "mm", "b", "ccc", "ddd", "x"]
        expected = ["ccc", "ddd", "aa", "mm", "zz", "b", "x"]
        for order in (terms, list(reversed(terms)), sorted(terms), terms[3:] + terms[:3]):
            self.assertEqual(cp._order_anchors(set(order)), expected)

    def test_a_longer_anchor_still_comes_first(self):
        self.assertEqual(cp._order_anchors({"a", "abc", "ab"}), ["abc", "ab", "a"])


if __name__ == "__main__":
    unittest.main()
