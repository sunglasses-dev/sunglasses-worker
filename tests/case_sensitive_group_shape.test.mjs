import test from "node:test";
import assert from "node:assert/strict";
import { pinRuleSource, chooseRuleRoad } from "../src/pinned.js";
import { ruleSources } from "./rule_class_helpers.mjs";

// No look-around stands inside a case-sensitive group of a rule's source, in either form. The rules' own sources are
// read as they stand; the check reads the sources the engine builds from them. Re-run: node --test tests/case_sensitive_group_shape.test.mjs
const groups = (src) => {
  const out = [];
  for (let i = src.indexOf("(?-i:"); i >= 0; i = src.indexOf("(?-i:", i + 5)) {
    let depth = 0, inClass = false, j = i;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === "\\") { j++; continue; }
      if (inClass) { if (c === "]") inClass = false; continue; }
      if (c === "[") inClass = true;
      else if (c === "(") depth++;
      else if (c === ")" && --depth === 0) break;
    }
    out.push(src.slice(i + 5, j));
  }
  return out;
};
const LOOK = /\(\?<?[=!]/;

test("no look-around stands inside a case-sensitive group of any rule, in the full form and in the ASCII form", () => {
  chooseRuleRoad();
  let seen = 0;
  for (const ascii of [false, true]) {
    for (const { source, flags } of ruleSources()) {
      if (!flags.includes("i")) continue;
      for (const body of groups(pinRuleSource(source, flags, ascii))) {
        seen++;
        assert.ok(!LOOK.test(body), "a look-around inside a case-sensitive group (" + (ascii ? "ASCII" : "full") + " form), " + body.length + " characters");
      }
    }
  }
  assert.ok(seen >= 1000, "the check read " + seen + " groups");
});

test("the check fails a source that holds a look-around inside a case-sensitive group", () => {
  assert.ok(groups("a(?-i:(?:(?![x])[a-z]))b").some((b) => LOOK.test(b)));
  assert.ok(!groups("a(?:(?-i:[a-z])(?<!(?-i:[x])))b").some((b) => LOOK.test(b)));
});
