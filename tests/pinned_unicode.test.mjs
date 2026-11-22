// The Worker reads the Unicode of the interpreter the pip scanner is measured on (src/unicode_tables.js), never the
// engine's own: the serving runtime is the edge, and its Unicode version moves without us.
//   1. each table is checked code point by code point against the runtime this test runs on. A runtime that is newer
//      may know MORE assigned code points; every code point it adds must be one the table calls unassigned. Nothing
//      else may differ in either direction.
//   2. the helpers (lower case, upper case, NFKC) equal the pinned interpreter's answer on every scalar.
//   3. no compiled rule, no helper, and no source file hands a \p{...} class, a case map or a normalization to the
//      engine's own tables: every RegExp built while the whole engine is built holds none, and the source holds none.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PINNED_UNICODE, PROPERTY_BODIES, pinSource, lowerPinned, upperPinned, nfkcPinned } from "../src/pinned.js";
import { UNICODE_PROPERTIES, UPPER_CASE } from "../src/unicode_tables.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const major = (v) => v.split(".").map(Number);
const runtimeNotOlder = () => { const [a, b] = major(process.versions.unicode), [c, d] = major(PINNED_UNICODE); return a > c || (a === c && b >= d); };
const scalars = function* () { for (let c = 0; c <= 0x10ffff; c++) if (c < 0xd800 || c > 0xdfff) yield c; };
const inRanges = (flat) => { const s = new Uint8Array(0x110000); for (let i = 0; i < flat.length; i += 2) s.fill(1, flat[i], flat[i + 1] + 1); return s; };

test("every table agrees with this runtime except for code points the pinned data has not assigned", { skip: !runtimeNotOlder() && "this runtime reads an older Unicode than the tables" }, () => {
  const unassigned = inRanges(UNICODE_PROPERTIES.Cn);
  for (const name of Object.keys(UNICODE_PROPERTIES)) {
    const table = inRanges(UNICODE_PROPERTIES[name]);
    const rx = new RegExp("^\\p{" + name + "}$", "u");
    const bad = [];
    for (const c of scalars()) {
      const runtime = rx.test(String.fromCodePoint(c)), pinned = table[c] === 1;
      if (runtime === pinned) continue;
      // The only difference a newer runtime may show: it knows a character the pinned data calls unassigned.
      //   a class it adds the character to (letter, number, mark, ...): the runtime says yes, the table says no;
      //   the classes that hold unassigned characters (C, Cn): the table says yes, the runtime says no.
      const newlyAssigned = unassigned[c] === 1 && (name === "C" || name === "Cn" ? pinned && !runtime : runtime && !pinned);
      if (!newlyAssigned) bad.push(c.toString(16));
    }
    assert.deepEqual(bad, [], name + ": " + bad.slice(0, 8).join(","));
  }
});

test("the helpers answer as the pinned interpreter does, on every scalar", () => {
  const unassigned = inRanges(UNICODE_PROPERTIES.Cn);
  const upper = new Map();
  for (let i = 0; i < UPPER_CASE.length;) { const n = UPPER_CASE[i + 1]; upper.set(UPPER_CASE[i], String.fromCodePoint(...UPPER_CASE.slice(i + 2, i + 2 + n))); i += 2 + n; }
  for (const c of scalars()) {
    const s = String.fromCodePoint(c);
    if (unassigned[c]) { assert.equal(lowerPinned(s), s, "lower " + c.toString(16)); assert.equal(nfkcPinned(s), s, "nfkc " + c.toString(16)); }
    else { assert.equal(lowerPinned(s), s.toLowerCase(), "lower " + c.toString(16)); assert.equal(nfkcPinned(s), s.normalize("NFKC"), "nfkc " + c.toString(16)); }
    assert.equal(upperPinned(s), upper.get(c) ?? (c < 0x80 ? s.toUpperCase() : s), "upper " + c.toString(16));
  }
});

test("a pinned run keeps its neighbours: a run of unassigned characters inside a text is passed through whole", () => {
  const hole = "\u{32ca4}";   // unassigned in the pinned data, assigned in Unicode 17
  assert.equal(lowerPinned("AB" + hole + "CD"), "ab" + hole + "cd");
  assert.equal(nfkcPinned("①" + hole + "Ａ"), "1" + hole + "A");
});

test("an engine-built RegExp holds the property pair only in a corrected class, and every rule's property is one the tables carry", async () => {
  const real = globalThis.RegExp;
  const seen = [];
  globalThis.RegExp = new Proxy(real, { construct(target, args, nt) { if (/\\[pP]\{/.test(String(args[0]))) seen.push(String(args[0])); return Reflect.construct(target, args, nt); } });
  try {
    const engine = await import("../src/engine.js");
    engine.buildAllRegexes();
    engine.buildAllFloors();
    for (const t of ["plain words in a row", "caf\u00e9 \u0e51\u0e52 x", "a \u{32ca4} b"]) await engine.scan(t, "file");
  } finally { globalThis.RegExp = real; }
  // the pair stands only inside the corrected forms (rule_classes.test.mjs proves those equal the tables' class on every code point)
  const CORRECTED = /\(\?:\(\?!\[[^\]\\]*\]\)\[[^\]]*\]\)|\(\?:\[[^\]\\]*\]\|\[\^[^\]]*\]\)|\(\?:\(\?-i:\[[^\]]*\]\)\(\?<!\(\?-i:\[[^\]\\]*\]\)\)\)|\(\?:\(\?-i:\[\^[^\]]*\]\)\|\(\?-i:\[[^\]\\]*\]\)\)/g;
  // (the first-use check compiles the bare pair, "[\p{L}\p{N}]" and its negation, to read the engine's own class: nothing else does)
  for (const src of seen.filter((x) => x !== "[\\p{L}\\p{N}]" && x !== "[^\\p{L}\\p{N}]")) assert.ok(!/\\[pP]\{/.test(src.replace(CORRECTED, "")), "a property class outside the corrected form: " + src);
  const { PATTERNS } = await import("../src/patterns.js");
  const { MECHANISMS } = await import("../src/mechanisms.js");
  const names = new Set();
  const walk = (v) => { if (typeof v === "string") { for (const m of v.matchAll(/\\[pP]\{([^}]*)\}/g)) names.add(m[1]); } else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") Object.values(v).forEach(walk); };
  walk(PATTERNS); walk(MECHANISMS);
  for (const n of names) assert.ok(n in PROPERTY_BODIES, "the tables carry no " + n);
  assert.doesNotThrow(() => pinSource("[\\p{L}\\p{N}_]"));
});

test("the source holds no regex literal with a property class and no case map or normalization outside pinned.js", () => {
  const ALLOWED_TOKEN_SITES = new Set(["index.js"]);   // page label + repo slug, never a match
  const offenders = [];
  for (const f of readdirSync(SRC).filter((n) => n.endsWith(".js"))) {
    if (["pinned.js", "unicode_tables.js", "patterns.js", "mechanisms.js", "html5_entities.js", "utf7_tables.js"].includes(f)) continue;
    const text = readFileSync(SRC + f, "utf8").split("\n");
    text.forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, "");
      if (!ALLOWED_TOKEN_SITES.has(f) && /\.(toLowerCase|toUpperCase|toLocaleLowerCase|toLocaleUpperCase|normalize)\(/.test(code)) offenders.push(f + ":" + (i + 1));
      if (/(^|[=(,:!&|?]\s*)\/(?![/*])[^/\n]*\\[pP]\{[^/\n]*\/[a-z]*/.test(code)) offenders.push(f + ":" + (i + 1) + " literal");
    });
  }
  assert.deepEqual(offenders, []);
});
