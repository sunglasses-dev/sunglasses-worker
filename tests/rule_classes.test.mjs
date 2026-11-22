import test from "node:test";
import assert from "node:assert/strict";
import {
  LETTER_NUMBER_BODY, pinSource, pinRuleSource, ruleRoad, chooseRuleRoad, deriveCorrection, checkCorrection, ruleClassCount,
} from "../src/pinned.js";
import { ruleSources, classesOf, ALL, equalOnEveryScalar } from "./rule_class_helpers.mjs";

test("the check holds on this runtime, on the derived lists, and fails a list that is wrong either way", () => {
  chooseRuleRoad();
  const corr = deriveCorrection();
  assert.ok(corr.plain.length > 0 && corr.folded.length > 0);
  assert.deepEqual(checkCorrection(corr), { ok: true });
  assert.equal(ruleRoad(), "corrected");
  // one run removed: a code point the engine holds beyond the tables is read as a letter
  assert.equal(checkCorrection({ plain: corr.plain.slice(2), folded: corr.folded }).ok, false);
  assert.equal(checkCorrection({ plain: corr.plain, folded: corr.folded.slice(2) }).ok, false);
  // one run added: a letter of the tables is read as not one
  assert.equal(checkCorrection({ plain: [...corr.plain, 0x41, 0x5a], folded: corr.folded }).ok, false);
  assert.equal(checkCorrection({ plain: corr.plain, folded: [...corr.folded, 0x4e00, 0x4e00] }).ok, false);
  // no list: the engine lacks something the tables have
  assert.equal(checkCorrection(null).ok, false);
  chooseRuleRoad();
});

test("a list that fails the check sends every rule to the tables' own classes", () => {
  const corr = deriveCorrection();
  chooseRuleRoad({ plain: corr.plain.slice(2), folded: corr.folded });
  assert.equal(ruleRoad(), "tables");
  assert.equal(pinRuleSource("[\\p{L}\\p{N}_]", "iu"), pinSource("[\\p{L}\\p{N}_]"));
  chooseRuleRoad(undefined, "tables");
  assert.equal(pinRuleSource("(?<![\\p{L}\\p{N}_])x", "isu"), pinSource("(?<![\\p{L}\\p{N}_])x"));
  chooseRuleRoad();
  assert.equal(ruleRoad(), "corrected");
});

test("every class form of every rule, under every flag set and fold state it occurs in, equals the explicit class on every scalar", () => {
  chooseRuleRoad();
  assert.equal(ruleRoad(), "corrected");
  const pairs = new Map();   // "form | flags | fold" -> { cls, flags, fold }
  let census = 0;
  for (const { source, flags } of ruleSources()) {
    for (const { cls, fold } of classesOf(source, flags)) {
      census++;
      pairs.set(cls + " | " + flags + " | " + fold, { cls, flags, fold });
    }
  }
  assert.ok(census > 10000, "census " + census);
  const forms = new Set([...pairs.values()].map((p) => p.cls));
  const flagSets = new Set([...pairs.values()].map((p) => p.flags));
  assert.ok(forms.size >= 15, "forms " + forms.size);
  assert.ok(flagSets.size >= 3, "flag sets " + [...flagSets]);
  let checked = 0;
  for (const { cls, flags } of pairs.values()) {
    const rewritten = pinRuleSource(cls, flags);
    assert.equal(ruleClassCount.tables >= 0, true);
    // the rewritten class and the explicit one, under this rule's own flags
    assert.ok(equalOnEveryScalar(rewritten, pinSource(cls), flags), "differs: " + cls + " under " + flags);
    checked++;
  }
  // the (form, flags) pairs the build test ran are the pairs of the rules
  assert.equal(checked, pairs.size);
});

test("every class of the rules is rewritten (census count), and the rewritten sources compile under their own flags", () => {
  chooseRuleRoad();
  assert.equal(ruleRoad(), "corrected");
  let census = 0, compiled = 0;
  ruleClassCount.corrected = 0;
  ruleClassCount.tables = 0;
  for (const { source, flags } of ruleSources()) {
    census += classesOf(source, flags).length;
    const out = pinRuleSource(source, flags);
    assert.ok(!/\\[pP]\{(?!L\}\\p\{N\})/.test(out.replace(/\\p\{L\}\\p\{N\}/g, "")), "a property class other than the pair is left in a rule source");
    new RegExp(out, flags);
    compiled++;
  }
  assert.ok(compiled > 0);
  assert.equal(ruleClassCount.corrected + ruleClassCount.tables, census);
  assert.equal(ruleClassCount.tables, 0, "every class of the rules is of the corrected form");
  assert.equal(ruleClassCount.corrected, census);
  console.log("rule classes rewritten:", ruleClassCount.corrected, "of", census);
});

test("the corrected class reads the same inside a look-behind, a look-ahead, a quantifier and a case-sensitive group", () => {
  chooseRuleRoad();
  assert.equal(ruleRoad(), "corrected");
  const contexts = [
    ["(?<![\\p{L}\\p{N}_])", "u"], ["(?<![\\p{L}\\p{N}_])", "iu"],
    ["(?![\\p{L}\\p{N}_-])", "iu"], ["(?:[\\p{L}\\p{N}_]{1,3})", "isu"],
    ["(?-i:[\\p{L}\\p{N}_])", "iu"], ["(?i:[\\p{L}\\p{N}_])", "u"],
    ["[^\\p{L}\\p{N}_]", "iu"], ["(?-i:[^\\p{L}\\p{N}_])", "imu"],
  ];
  // each scalar is followed by "x"; the rule asks what stands before / after / around it
  const text = [...ALL].map((ch) => ch + "x").join("");
  for (const [ctx, flags] of contexts) {
    const src = ctx.startsWith("(?<!") ? ctx + "x" : ctx.startsWith("(?!") ? "x" + ctx : ctx + "x";
    const a = text.replace(new RegExp(pinRuleSource(src, flags), "g" + flags), "");
    const b = text.replace(new RegExp(pinSource(src), "g" + flags), "");
    assert.equal(a, b, ctx + " under " + flags);
  }
});

test("a class that is not of the corrected form reads the tables' class, and a source with no property is left alone", () => {
  chooseRuleRoad();
  assert.equal(pinRuleSource("abc[a-z]\\d", "iu"), "abc[a-z]\\d");
  for (const odd of ["[\\p{L}_]", "[\\p{N}\\p{L}_]", "[\\p{L}\\p{N}\\p{L}\\p{N}]", "[\\p{L}\\p{N}\\d]", "[\\p{L}\\p{N}\\s]", "[\\p{L}\\p{N}é]"]) {
    assert.equal(pinRuleSource(odd, "iu"), pinSource(odd), odd);
  }
  // a pair outside a class is the tables' own
  assert.equal(pinRuleSource("\\p{L}+", "iu"), pinSource("\\p{L}+"));
  // no flags given: the tables' own
  assert.equal(pinRuleSource("[\\p{L}\\p{N}_]", undefined), pinSource("[\\p{L}\\p{N}_]"));
});

test("the corrected class is much shorter than the explicit one", () => {
  chooseRuleRoad();
  const a = pinRuleSource("[\\p{L}\\p{N}_]", "iu").length, b = pinSource("[\\p{L}\\p{N}_]").length;
  assert.ok(a * 10 < b, a + " against " + b);
  assert.ok(LETTER_NUMBER_BODY.length > 1000);
});
