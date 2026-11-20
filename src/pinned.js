// The Unicode this Worker reads is the Unicode of the interpreter the pip scanner is measured on (PINNED_UNICODE),
// written by range in unicode_tables.js. The classes (\p{...}), upper case and the printable test are never the
// engine's own: a JavaScript engine answers them from the Unicode version it was built with, and the edge moves without
// us. Lower case and compatibility normalization (NFKC) take the engine's answer for an assigned character, held equal
// to the pinned version on every assigned character by tests/unicode_case_digests.test.mjs. Every property a rule or a
// helper reads goes through this file, and a code point the pinned data has not assigned is an unassigned character to
// all of them.
import { PINNED_UNICODE, UNICODE_PROPERTIES, UPPER_CASE } from "./unicode_tables.js";

export { PINNED_UNICODE };

const hex = (c) => "\\u{" + c.toString(16) + "}";
const BODIES = {};
for (const [name, flat] of Object.entries(UNICODE_PROPERTIES)) {
  let body = "";
  for (let i = 0; i < flat.length; i += 2) body += flat[i] === flat[i + 1] ? hex(flat[i]) : hex(flat[i]) + "-" + hex(flat[i + 1]);
  BODIES[name] = body;
}
export const PROPERTY_BODIES = BODIES;

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
