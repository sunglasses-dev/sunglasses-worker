// A class the Worker writes from a pinned table holds exactly the table's code points, and the rules built with those
// classes stay small enough for one isolate. Local only.
//   1. every property body, and the merged letter+number body, matches the same code points as the table it is written
//      from: scalars as one pass over a string of all of them, lone surrogates one by one.
//   2. pinSource turns \p{L}\p{N} inside a class into the merged body and every other \p{...} into its own body.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROPERTY_BODIES, LETTER_NUMBER_BODY, pinSource } from "../src/pinned.js";
import { UNICODE_PROPERTIES } from "../src/unicode_tables.js";

const ALL_SCALARS = (() => {
  const parts = [];
  for (let c = 0; c <= 0x10ffff; c += 4096) {
    const cps = [];
    for (let d = c; d < c + 4096 && d <= 0x10ffff; d++) if (d < 0xd800 || d > 0xdfff) cps.push(d);
    parts.push(String.fromCodePoint(...cps));
  }
  return parts.join("");
})();
const held = (flat) => {
  const out = [];
  for (let i = 0; i < flat.length; i += 2) {
    for (let c = flat[i]; c <= flat[i + 1]; c++) if (c < 0xd800 || c > 0xdfff) out.push(c);
  }
  return out;
};
const chunked = (cps) => { let s = ""; for (let i = 0; i < cps.length; i += 4096) s += String.fromCodePoint(...cps.slice(i, i + 4096)); return s; };
const mergedFlat = () => {
  const have = new Set([...held(UNICODE_PROPERTIES.L), ...held(UNICODE_PROPERTIES.N)]);
  return [...have].sort((a, b) => a - b);
};

for (const [name, body] of [...Object.entries(PROPERTY_BODIES), ["L+N", LETTER_NUMBER_BODY]]) {
  test("the class written from " + name + " holds exactly the table's code points", () => {
    const expected = name === "L+N" ? chunked(mergedFlat()) : chunked(held(UNICODE_PROPERTIES[name]));
    const got = (ALL_SCALARS.match(new RegExp("[" + body + "]", "gu")) || []).join("");
    assert.equal(got === expected, true, name + ": the class and the table differ");
    const rx = new RegExp("^[" + body + "]$", "u");
    const flat = name === "L+N" ? null : UNICODE_PROPERTIES[name];
    for (let c = 0xd800; c <= 0xdfff; c++) {
      const inTable = flat ? flat.some((v, i) => i % 2 === 0 && c >= v && c <= flat[i + 1]) : false;
      assert.equal(rx.test(String.fromCharCode(c)), inTable, name + " lone surrogate " + c.toString(16));
    }
  });
}

test("a letter and a number side by side in a class is one merged class, every other property keeps its own", () => {
  assert.equal(pinSource("[\\p{L}\\p{N}_]"), "[" + LETTER_NUMBER_BODY + "_]");
  assert.equal(pinSource("[^\\p{L}\\p{N}_]"), "[^" + LETTER_NUMBER_BODY + "_]");
  assert.equal(pinSource("[\\p{N}\\p{L}]"), "[" + PROPERTY_BODIES.N + PROPERTY_BODIES.L + "]");
  assert.equal(pinSource("\\p{L}\\p{N}"), "[" + PROPERTY_BODIES.L + "][" + PROPERTY_BODIES.N + "]");
  assert.equal(pinSource("\\\\p{L}\\\\p{N}"), "\\\\p{L}\\\\p{N}");
});
