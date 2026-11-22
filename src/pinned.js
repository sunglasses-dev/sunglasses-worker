// The Unicode this Worker reads is the Unicode of the interpreter the pip scanner is measured on (PINNED_UNICODE),
// written by range in unicode_tables.js. The classes (\p{...}), upper case and the printable test are never the
// engine's own: a JavaScript engine answers them from the Unicode version it was built with, and the edge moves without
// us. Lower case and compatibility normalization (NFKC) take the engine's answer for an assigned character, held equal
// to the pinned version on every assigned character by tests/unicode_case_digests.test.mjs. Every property a rule or a
// helper reads goes through this file, and a code point the pinned data has not assigned is an unassigned character to
// all of them.
import { PINNED_UNICODE, UNICODE_PROPERTIES, UPPER_CASE } from "./unicode_tables.js";

export { PINNED_UNICODE };

// A code point as it sits inside a class. Below U+0080 and for a lone surrogate it is the escape (those are the
// characters a class source treats as syntax or cannot hold); every other code point is the character itself, which
// is the same code point to the engine and a fifth of the source: the rules hold thousands of these classes.
const hex = (c) => (c < 0x80 || (c >= 0xd800 && c <= 0xdfff) ? "\\u{" + c.toString(16) + "}" : String.fromCodePoint(c));
const bodyOf = (runs) => {
  let body = "";
  for (let i = 0; i < runs.length; i += 2) body += runs[i] === runs[i + 1] ? hex(runs[i]) : hex(runs[i]) + "-" + hex(runs[i + 1]);
  return body;
};
const BODIES = {};
for (const [name, flat] of Object.entries(UNICODE_PROPERTIES)) BODIES[name] = bodyOf(flat);
export const PROPERTY_BODIES = BODIES;

// \p{L}\p{N} side by side inside one class is the word class of nearly every rule. Written as ONE class of merged
// ranges it is the same set in fewer ranges than the two bodies one after the other.
const merge = (...names) => {
  const all = [];
  for (const n of names) for (let i = 0; i < UNICODE_PROPERTIES[n].length; i += 2) all.push([UNICODE_PROPERTIES[n][i], UNICODE_PROPERTIES[n][i + 1]]);
  all.sort((x, y) => x[0] - y[0]);
  const runs = [];
  for (const [lo, hi] of all) {
    if (runs.length && lo <= runs[runs.length - 1] + 1) runs[runs.length - 1] = Math.max(runs[runs.length - 1], hi);
    else runs.push(lo, hi);
  }
  return bodyOf(runs);
};
export const LETTER_NUMBER_BODY = merge("L", "N");
const LETTER_NUMBER = "\\p{L}\\p{N}";

// A regex source with each \p{Name} outside a class written as the class of its code points and each one inside a
// class written as the ranges, an escaped backslash left as it is. \P{Name} outside a class is the complement
// class. The \u{...} form needs flag u (or v); every source that reaches here carries one.
const PROPERTY_TOKEN = /\\[pP]\{/;
export function pinSource(source) {
  if (!PROPERTY_TOKEN.test(source)) return source;
  let out = "";
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      const n = source[i + 1];
      if (inClass && source.startsWith(LETTER_NUMBER, i)) {
        out += LETTER_NUMBER_BODY;
        i += LETTER_NUMBER.length - 1;
        continue;
      }
      if ((n === "p" || n === "P") && source[i + 2] === "{") {
        const close = source.indexOf("}", i + 3);
        const name = source.slice(i + 3, close);
        const body = BODIES[name];
        if (close < 0 || body === undefined) throw new Error("the pinned tables have no property " + name);
        if (n === "p") out += inClass ? body : "[" + body + "]";
        else {
          if (inClass) throw new Error("a \\P{" + name + "} inside a class has no class form here");
          out += "[^" + body + "]";
        }
        i = close;
        continue;
      }
      out += c + (n === undefined ? "" : n);
      i++;
      continue;
    }
    if (!inClass && c === "[") inClass = true;
    else if (inClass && c === "]") inClass = false;
    out += c;
  }
  return out;
}

// A regex built from a source that may name properties.
export function pinRx(source, flags) {
  return new RegExp(pinSource(source), flags);
}

// THE GATE OF THE ASCII FORM. A text holding none of the scalars this matches reads a rule's word classes the same
// in the ASCII form as in the tables' form. Case-insensitive on purpose: under flag i a class also takes a scalar that
// folds to one of its letters (U+0345 folds to a Greek letter), so those scalars count as outside as well.
export const ASCII_FORM_GATE_SOURCE = "(?![\\x00-\\x7f])[\\p{L}\\p{N}]";
export const ASCII_FORM_GATE = pinRx(ASCII_FORM_GATE_SOURCE, "iu");

// ── the rules' letter-and-number class ─────────────────────────────────────────────────────────────────────────────────
// A rule reads \p{L}\p{N} next to a few ASCII characters in a class, ten thousand times over. Each class is the
// engine's own, with the code points the engine holds beyond the pinned tables taken out (list E):
//     [X]   is   (?:(?![E])[X])        and        [^X]   is   (?:[E]|[^X])
// E is read from the engine at the first rule compiled: once for a class that reads case as written (flag u) and once
// for a class that folds case (flag iu), since a code point the engine lists as a letter only through its case pair
// is in the first list and not in the second. The rest of a class (the ASCII characters beside the pair) stays in the
// class as it is. The Worker then checks, over every code point and for both lists, that the corrected classes equal
// the pinned tables' class. When the engine holds fewer than the tables, or the check does not hold, every rule reads
// the tables' own classes (pinSource): the answer never depends on the engine's Unicode, only the memory does.
const wrapFor = (runs) => {
  const e = bodyOf(runs);
  return {
    pos: (cls) => (e ? "(?:(?![" + e + "])" + cls + ")" : cls),
    neg: (cls) => (e ? "(?:[" + e + "]|" + cls + ")" : cls),
  };
};
const wraps = (corr) => ({ plain: wrapFor(corr.plain), folded: wrapFor(corr.folded) });
let scalarsText = null;
const allScalars = () => (scalarsText ??= (() => {
  const units = new Uint16Array(2 * 0x110000);
  let n = 0;
  for (let c = 0; c < 0x10000; c++) if (c < 0xd800 || c > 0xdfff) units[n++] = c;
  for (let c = 0x10000; c <= 0x10ffff; c++) {
    units[n++] = 0xd800 + ((c - 0x10000) >> 10);
    units[n++] = 0xdc00 + ((c - 0x10000) & 1023);
  }
  return new TextDecoder("utf-16le").decode(units.subarray(0, n));
})());
const PAIR_CLASS = "[\\p{L}\\p{N}]", NPAIR_CLASS = "[^\\p{L}\\p{N}]";
const toRuns = (chars) => {
  const runs = [];
  for (const ch of chars) {
    const c = ch.codePointAt(0);
    if (runs.length && runs[runs.length - 1] === c - 1) runs[runs.length - 1] = c;
    else runs.push(c, c);
  }
  return runs;
};
// The text of all scalars the tables' class does not hold, for one flag set: read once, used by the derivation and by
// the check.
const notExplicitCache = new Map();
const notExplicitText = (flags) => {
  let t = notExplicitCache.get(flags);
  if (t === undefined) {
    t = allScalars().replace(new RegExp("[" + LETTER_NUMBER_BODY + "]", "g" + flags), "");
    notExplicitCache.set(flags, t);
  }
  return t;
};
// The correction the engine here needs, read from the engine: the code points its class holds and the tables' does not.
// A code point the tables hold and the engine lacks is not found here; the check finds it.
export function deriveCorrection() {
  const engineOnly = (flags) => toRuns((notExplicitText(flags).match(new RegExp(PAIR_CLASS, "g" + flags)) ?? []).join(""));
  return { plain: engineOnly("u"), folded: engineOnly("iu") };
}
// { ok, why }: does the corrected class equal the tables' class on every code point, for flags u and iu, in both
// forms (the class and the negated class)?
export function checkCorrection(corr) {
  try {
    if (!corr) return { ok: false, why: "the engine lacks code points the tables have" };
    const w = wraps(corr);
    const all = allScalars();
    for (const [flags, wrap] of [["u", w.plain], ["iu", w.folded]]) {
      const notExplicit = notExplicitText(flags);
      if (all.replace(new RegExp(wrap.pos(PAIR_CLASS), "g" + flags), "") !== notExplicit) return { ok: false, why: "class, flags " + flags };
      // the negated form holds exactly the characters of notExplicit, and none of the others
      const neg = new RegExp(wrap.neg(NPAIR_CLASS), "g" + flags);
      if (notExplicit.replace(neg, "") !== "") return { ok: false, why: "negated class, flags " + flags };
      const held = all.replace(new RegExp("[^" + LETTER_NUMBER_BODY + "]", "g" + flags), "");
      if (held.replace(neg, "") !== held) return { ok: false, why: "negated class takes a letter, flags " + flags };
      // a lone surrogate is in neither class (the strings above hold whole characters only)
      const one = new RegExp(wrap.pos(PAIR_CLASS), flags), none = new RegExp(wrap.neg(NPAIR_CLASS), flags);
      for (let c = 0xd800; c <= 0xdfff; c++) {
        const ch = String.fromCharCode(c);
        if (one.test(ch) || !none.test(ch)) return { ok: false, why: "a lone surrogate, flags " + flags };
      }
    }
    return { ok: true };
  } catch {
    return { ok: false, why: "error" };
  }
}

// The road the rules take: "corrected" or "tables". Chosen at the first rule compiled, never at module start.
let road = null;
let roadCorrection = null;
let roadWraps = null;
export const ruleRoad = () => {
  if (road === null && globalThis.SUNGLASSES_RULE_ROAD === "tables") road = "tables";   // a switch that only picks the tables' own classes
  if (road === null) {
    roadCorrection = roadCorrection ?? deriveCorrection();
    road = checkCorrection(roadCorrection).ok ? "corrected" : "tables";
  }
  return road;
};
// For tests: give the list the check reads (the derived one when none), or force a road, and forget the earlier choice.
export function chooseRuleRoad(corr, forced) {
  roadCorrection = corr ?? null;
  road = forced ?? null;
  roadWraps = null;
}

// One class "[...]" of a rule source, written for the road. Only the exact form the rules use is corrected: the pair
// \p{L}\p{N} once, no other property, the rest ASCII punctuation or a space or a plain escape. Anything else reads the
// tables' own class.
const SAFE_REST = /^(?:[ -\/:-@\[^-`{-~]|\\[tnrfv\]\[\\\-.\/^$*+?()|{}])*$/u;
const PAIR = "\\p{L}\\p{N}";
const ASCII_PAIR = "A-Za-z0-9";
export const ruleClassCount = { corrected: 0, tables: 0, ascii: 0 };   // classes written each way (a test reads it)
function ruleClass(cls, wrap, ascii) {
  const neg = cls[1] === "^";
  const body = cls.slice(neg ? 2 : 1, -1);
  if (!body.includes("\\p{") && !body.includes("\\P{")) return cls;
  const at = body.indexOf(PAIR);
  const rest = at < 0 ? "" : body.slice(0, at) + body.slice(at + PAIR.length);
  if (at < 0 || body.indexOf(PAIR, at + 1) >= 0 || rest.includes("\\p") || rest.includes("\\P") || !SAFE_REST.test(rest)) {
    ruleClassCount.tables++;
    return pinSource(cls);
  }
  if (ascii) {
    ruleClassCount.ascii++;
    return cls.replace(PAIR, ASCII_PAIR);
  }
  ruleClassCount.corrected++;
  return neg ? wrap.neg(cls) : wrap.pos(cls);
}
const classEnd = (source, from) => {
  let i = from + 1;
  if (source[i] === "^") i++;
  for (; i < source.length; i++) {
    if (source[i] === "\\") i++;
    else if (source[i] === "]") return i;
  }
  return -1;
};
// The word class of a rule written for a case-sensitive island, null when the class is not the one the rules use.
function islandClass(cls, extra) {
  const neg = cls[1] === "^";
  const body = cls.slice(neg ? 2 : 1, -1);
  if (!body.includes("\\p{")) return null;
  const at = body.indexOf(PAIR);
  const rest = at < 0 ? "" : body.slice(0, at) + body.slice(at + PAIR.length);
  if (at < 0 || body.indexOf(PAIR, at + 1) >= 0 || rest.includes("\\p") || rest.includes("\\P") || !SAFE_REST.test(rest)) return null;
  ruleClassCount.corrected++;
  const e = bodyOf(extra);
  if (!e) return "(?-i:" + cls + ")";
  return neg ? "(?:(?-i:" + cls + ")|(?-i:[" + e + "]))" : "(?:(?-i:" + cls + ")(?<!(?-i:[" + e + "])))";
}
const GROUP_FLAGS = /^\(\?([ims]*)(?:-([ims]*))?:/;
// A rule's source for the road, given the flags it compiles with. Whether a class folds case is read from the rule's
// flag i and from the (?i:...) and (?-i:...) groups around the class.
export function pinRuleSource(source, flags, ascii = false) {
  if (!PROPERTY_TOKEN.test(source)) return source;
  if (typeof flags !== "string" || (!ascii && ruleRoad() !== "corrected")) return pinSource(source);
  const w = ascii ? null : (roadWraps ??= wraps(roadCorrection));
  const stack = [flags.includes("i")];
  let out = "";
  for (let i = 0; i < source.length;) {
    const c = source[i];
    if (c === "\\") {
      const n = source[i + 1];
      if ((n === "p" || n === "P") && source[i + 2] === "{") {
        const close = source.indexOf("}", i + 3);
        out += pinSource(source.slice(i, close + 1));
        i = close + 1;
        continue;
      }
      out += c + (n ?? "");
      i += 2;
      continue;
    }
    if (c === "[") {
      const end = classEnd(source, i);
      if (end < 0) { out += source.slice(i); break; }
      out += ruleClass(source.slice(i, end + 1), ascii ? null : (stack[stack.length - 1] ? w.folded : w.plain), ascii);
      i = end + 1;
      continue;
    }
    if (c === "(" && w !== null && flags.includes("i") && source.startsWith("(?-i:[", i)) {
      // A case-sensitive island holding one word class. The class the rules read is the engine's class less the code
      // points it holds and the tables do not. It is written as two islands, the class and a lookbehind on the code point
      // just read, so no look-around stands inside an island: the same code points on every scalar.
      const end = classEnd(source, i + 5);
      if (end > 0 && source[end + 1] === ")") {
        const cls = source.slice(i + 5, end + 1);
        const done = islandClass(cls, roadCorrection.plain);
        if (done !== null) { out += done; i = end + 2; continue; }
      }
    }
    if (c === "(") {
      let fold = stack[stack.length - 1];
      const m = GROUP_FLAGS.exec(source.slice(i, i + 12));
      if (m) {
        if (m[1].includes("i")) fold = true;
        if (m[2]?.includes("i")) fold = false;
      }
      stack.push(fold);
    } else if (c === ")" && stack.length > 1) stack.pop();
    out += c;
    i++;
  }
  return out;
}

// ── case mapping and normalization: the engine's own answer only for assigned characters ───────────────────────────
// A code point the pinned data has not assigned passes through untouched, as it does in the interpreter. The engine's
// answer for it would be a case pair or a compatibility form the interpreter does not have.
const UNASSIGNED_ONE = new RegExp("[" + BODIES.Cn + "]", "u");
const UNASSIGNED_RUN = new RegExp("[" + BODIES.Cn + "]+", "gu");
const NON_ASCII = /[^\x00-\x7f]/;
export function mapAssigned(text, fn) {
  if (!NON_ASCII.test(text) || !UNASSIGNED_ONE.test(text)) return fn(text);
  let out = "";
  let at = 0;
  UNASSIGNED_RUN.lastIndex = 0;
  for (let m; (m = UNASSIGNED_RUN.exec(text)) !== null;) {
    if (m.index > at) out += fn(text.slice(at, m.index));
    out += m[0];
    at = m.index + m[0].length;
  }
  if (at < text.length) out += fn(text.slice(at));
  return out;
}
export const lowerPinned = (text) => mapAssigned(text, (t) => t.toLowerCase());
// str.upper() written whole from the table: the engine's own answer drifts on a character that is assigned in both
// versions, so passing the unassigned through is not enough here.
const UPPER = new Map();
for (let i = 0; i < UPPER_CASE.length;) {
  const n = UPPER_CASE[i + 1];
  UPPER.set(UPPER_CASE[i], String.fromCodePoint(...UPPER_CASE.slice(i + 2, i + 2 + n)));
  i += 2 + n;
}
export function upperPinned(text) {
  if (!NON_ASCII.test(text)) return text.toUpperCase();
  let out = "";
  for (const ch of text) out += UPPER.get(ch.codePointAt(0)) ?? (ch < "\x80" ? ch.toUpperCase() : ch);
  return out;
}
export const nfkcPinned = (text) => mapAssigned(text, (t) => t.normalize("NFKC"));
