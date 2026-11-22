import test from "node:test";
import assert from "node:assert/strict";
import { pinSource, pinRuleSource, chooseRuleRoad, ruleClassCount, ASCII_FORM_GATE } from "../src/pinned.js";
import { withPythonDigits } from "../src/preprocessor.js";
import { ruleSources, classesOf, ALL } from "./rule_class_helpers.mjs";

// THE ASCII FORM. A text with no letter or digit outside ASCII reads a rule's word classes as the ASCII ranges. This file
// proves it over every scalar value: on every scalar the gate lets through (not a letter or digit outside ASCII, and none that folds to one), the ASCII form and the
// tables' form leave the same text. Re-run: node --test tests/ascii_form.test.mjs
const OUTSIDE = new RegExp(ASCII_FORM_GATE.source, "giu");   // the engine's own gate
const REST = ALL.replace(OUTSIDE, "");   // every scalar the ASCII form is used on, one text
const left = (source, flags) => REST.replace(new RegExp(source, "g" + flags.replace(/[gy]/g, "")), "");

test("on every scalar the gate lets through, the ASCII form of every class of the rules equals the tables' class, under every flag set it occurs in", () => {
  chooseRuleRoad();
  const pairs = new Map();
  for (const { source, flags } of ruleSources()) {
    for (const { cls } of classesOf(source, flags)) pairs.set(cls + " | " + flags, { cls, flags });
  }
  assert.ok(pairs.size >= 15);
  assert.ok(new Set([...pairs.values()].map((p) => p.flags)).size >= 3, "every flag set the rules carry");
  const before = ruleClassCount.ascii;
  let differs = 0;
  for (const { cls, flags } of pairs.values()) {
    const ascii = pinRuleSource(cls, flags, true);
    const tables = pinSource(cls);
    assert.equal(left(ascii, flags), left(tables, flags), "differs: " + cls + " under " + flags);
    // the form is a real rewrite: on the scalars it is not used on, the two forms do differ
    if (ALL.replace(new RegExp(ascii, "g" + flags.replace(/[gy]/g, "")), "") !== ALL.replace(new RegExp(tables, "g" + flags.replace(/[gy]/g, "")), "")) differs++;
  }
  assert.ok(ruleClassCount.ascii - before >= pairs.size, "every class was written in the ASCII form");
  assert.ok(differs > 0, "the ASCII form differs from the tables' on a letter outside ASCII, so the check on the others means something");
  console.log("ASCII form: classes x flag sets checked on every scalar:", pairs.size, " scalars per check:", REST.length);
});

test("the digit class and its negation read the same on those scalars, in a class and outside one, under every flag set", () => {
  const ones = ["\\d", "\\D", "[\\d]", "[^\\d]", "[\\d.]", "[^\\d.]", "[\\s\\d]", "[^\\s\\d_]"];
  for (const flags of ["isu", "iu", "imu", "u"]) {
    for (const one of ones) {
      const ascii = withPythonDigits(one, flags, true);
      const tables = withPythonDigits(one, flags, false);
      assert.equal(left(ascii, flags), left(tables, flags), one + " under " + flags);
    }
  }
});

test("every source of the rules compiles in the ASCII form, under its own flags", () => {
  let n = 0;
  for (const { source, flags } of ruleSources()) {
    new RegExp(withPythonDigits(source, flags, true), flags);
    n++;
  }
  assert.ok(n > 100, "sources " + n);
});

test("the ASCII form is smaller than the corrected form, which is smaller than the tables' form", () => {
  const size = () => {
    let n = 0;
    for (const { source, flags } of ruleSources()) n += withPythonDigits(source, flags, false).length;
    return n;
  };
  chooseRuleRoad(undefined, "tables");
  const tables = size();
  chooseRuleRoad();
  const corrected = size();
  let ascii = 0;
  for (const { source, flags } of ruleSources()) ascii += withPythonDigits(source, flags, true).length;
  console.log("expanded chars of every rule source: tables road", tables, " corrected", corrected, " ASCII", ascii);
  assert.ok(ascii < corrected && corrected < tables);
});
