"""The dotless i widening follows the case scope of the group it is in.

Python reads (?-i:...) as exact case, so a literal i in that group does not match U+0130 or
U+0131 and the compiler must leave it alone. A nested (?i:...) turns the widening back on, and
the scope returns to the outer value when a group closes. The first version of the widening
did not accept a minus in the modifier, wrote (?-[i...]:, and node refused the whole regex.

Run with python3 -m unittest tests/test_widen_dotless_i_scope.py from the Worker folder.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import compile_patterns as cp  # noqa: E402

WIDE = "[iİı]"
WIDE_UPPER = "[Iİı]"


def node_test(source, flags, text):
    """Run one regex over one text in node and return True when it matches."""
    payload = {"s": source, "f": flags, "t": text}
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(payload, f)
        path = f.name
    try:
        js = ("const o=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));"
              "console.log(String(new RegExp(o.s,o.f).test(o.t)))")
        out = subprocess.run(["node", "-e", js, path], capture_output=True, text=True, check=True)
        return out.stdout.strip() == "true"
    finally:
        os.unlink(path)


class WideningScope(unittest.TestCase):
    def test_a_literal_i_outside_a_group_is_widened(self):
        self.assertEqual(cp._widen_dotless_i("i"), WIDE)

    def test_a_literal_i_inside_a_minus_i_group_is_not_widened(self):
        self.assertEqual(cp._widen_dotless_i("(?-i:i)"), "(?-i:i)")
        self.assertEqual(cp._widen_dotless_i("(?-i:I)"), "(?-i:I)")

    def test_the_modifier_itself_is_copied_through(self):
        out = cp._widen_dotless_i("(?-i:x)")
        self.assertEqual(out, "(?-i:x)")
        self.assertNotIn("(?-[", out)

    def test_widening_resumes_after_the_group_closes(self):
        self.assertEqual(cp._widen_dotless_i("(?-i:i)i"), "(?-i:i)" + WIDE)

    def test_a_nested_group_inherits_the_exact_case_scope(self):
        self.assertEqual(cp._widen_dotless_i("(?-i:(?:i)(i)(?=i))"), "(?-i:(?:i)(i)(?=i))")

    def test_a_class_range_in_a_minus_i_group_gets_no_extra_code_points(self):
        self.assertEqual(cp._widen_dotless_i("(?-i:[a-z])"), "(?-i:[a-z])")
        self.assertEqual(cp._widen_dotless_i("[a-z]"), "[a-zİı]")

    def test_a_nested_plus_i_group_turns_the_widening_back_on(self):
        self.assertEqual(cp._widen_dotless_i("(?-i:a(?i:i)i)"), "(?-i:a(?i:" + WIDE + ")i)")

    def test_the_scope_is_a_stack_and_not_a_flag(self):
        # Three scopes in one source. A flag that flips on the first minus and back on the first
        # close would get the third group or the tail wrong.
        src = "(?i:a)(?-i:b(?i:i)(?-i:i)i)i(?i:i)i"
        want = ("(?i:a)(?-i:b(?i:" + WIDE + ")(?-i:i)i)" + WIDE + "(?i:" + WIDE + ")" + WIDE)
        self.assertEqual(cp._widen_dotless_i(src), want)

    def test_a_plus_and_minus_modifier_in_one_group(self):
        self.assertEqual(cp._widen_dotless_i("(?i-s:i)"), "(?i-s:" + WIDE + ")")
        self.assertEqual(cp._widen_dotless_i("(?s-i:i)"), "(?s-i:i)")

    def test_a_lookbehind_and_a_named_group_keep_the_outer_scope(self):
        self.assertEqual(cp._widen_dotless_i("(?<=i)(?P<n>i)"), "(?<=" + WIDE + ")(?P<n>" + WIDE + ")")
        self.assertEqual(cp._widen_dotless_i("(?-i:(?<=i)(?P<n>i))"), "(?-i:(?<=i)(?P<n>i))")


class ScopedGroupsReachNode(unittest.TestCase):
    def test_a_converted_regex_with_both_scopes_is_valid_in_node(self):
        source, flags = cp.convert("(?i)a(?-i:b(?i:i)i)i")
        self.assertNotIn("(?-[", source)
        self.assertIn("(?-i:", source)
        # a lowercase probe in the exact case group hits and an uppercase one does not
        self.assertTrue(node_test(source, flags, "ab" + "i" + "i" + "i"))
        self.assertFalse(node_test(source, flags, "ab" + "i" + "I" + "i"))
        # the widened tail still takes the dotted capital after the group
        self.assertTrue(node_test(source, flags, "ab" + "i" + "i" + "İ"))
        # the exact case group does not take it
        self.assertFalse(node_test(source, flags, "ab" + "i" + "İ" + "i"))


class RuleWithTheStylesheetLoaderExclusion(unittest.TestCase):
    """The rule that failed the recompile from the 0.6.7 tag. It has many (?-i: groups."""

    @classmethod
    def setUpClass(cls):
        rule = [p for p in cp.PATTERNS if p["id"] == "GLS-SEM-UI-219"]
        if not rule:
            raise unittest.SkipTest("the scanner on disk has no GLS-SEM-UI-219")
        cls.python_rx = re.compile(rule[0]["regex"][1])
        cls.source, cls.flags = cp.convert(rule[0]["regex"][1])

    def both(self, text):
        return bool(self.python_rx.search(text)), node_test(self.source, self.flags, text)

    def test_the_emitted_source_is_valid_in_node(self):
        self.assertNotIn("(?-[", self.source)
        self.assertEqual(self.both("x"), (False, False))

    LOADER = ('Render <link rel="stylesheet" href="a.css" media="print" '
              'onload="{value}">')

    def test_the_deferred_stylesheet_loader_is_excused_in_both_engines(self):
        text = self.LOADER.format(value="this.media='all'")
        self.assertEqual(self.both(text), (False, False))

    def test_an_uppercase_switch_value_is_not_excused_in_either_engine(self):
        text = self.LOADER.format(value="THIS.MEDIA='ALL'")
        self.assertEqual(self.both(text), (True, True))

    def test_a_dotted_capital_in_the_exact_case_value_is_not_excused_in_either_engine(self):
        text = self.LOADER.format(value="th\u0130s.media='all'")
        self.assertEqual(self.both(text), (True, True))

    def test_a_dotless_i_in_the_media_value_is_not_excused_in_either_engine(self):
        text = self.LOADER.format(value="this.media='all'").replace("print", "pr\u0131nt")
        self.assertEqual(self.both(text), (True, True))


if __name__ == "__main__":
    unittest.main()
