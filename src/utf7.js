// UTF-7 runs, read the way a model reads them. Port of the pip scanner's utf7.py.
//
// A model asked to "decode this UTF-7" will do it, and `+AEkAZwBuAG8AcgBl-` is `Ignore`. No step of the
// pipeline decodes this form, so a sentence that is stopped in plain text could pass when it is written as
// UTF-7. utf7View(text) is the text with each run that decodes to something readable replaced by that
// decode. The scan reads the view in addition to the text, never instead of it (see scan in engine.js).
//
// One level only: a run is decoded once and the view is never decoded again. One linear pass: `+` is found
// with indexOf and the run after it is taken by a single character-class walk, so nothing backtracks.
import {
  IGNORABLE_RANGES,
  normalizeUnicode,
  replaceHomoglyphs,
  replaceLookalikes,
  stripIgnorable,
  stripInvisible,
} from "./preprocessor.js";
import { UTF7_STRETCHES } from "./utf7_tables.js";

// One UTF-16 unit needs three base64 letters. A larger minimum would let a payload split into short runs.
const MIN_BODY = 3;
// Bodies shorter than this are decoded strictly (the codec refuses a run whose leftover bits are not zero).
const STRICT_BELOW = 8;
// A decode with a mix of scripts is text when it holds this many characters in a row that are ASCII or fold to ASCII.
const ASCII_STRETCH = 4;

const BASE64 = new Int8Array(128).fill(-1);
for (let i = 0; i < 26; i++) {
  BASE64[65 + i] = i;
  BASE64[97 + i] = 26 + i;
}
for (let i = 0; i < 10; i++) BASE64[48 + i] = 52 + i;
BASE64[43] = 62;
BASE64[47] = 63;

const isBodyUnit = (u) => u < 128 && BASE64[u] >= 0;
const isHigh = (u) => u >= 0xd800 && u <= 0xdbff;
const isLow = (u) => u >= 0xdc00 && u <= 0xdfff;
const isSurrogate = (c) => c >= 0xd800 && c <= 0xdfff;

// The characters read as nothing: controls, spaces and the invisible ranges, as pinned code point ranges.
const NEUTRAL_RANGES = [
  [0x00, 0x1f], [0x7f, 0x9f], [0x20, 0x20], [0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a],
  [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000], ...IGNORABLE_RANGES,
];
function isNeutral(cp) {
  for (const [lo, hi] of NEUTRAL_RANGES) if (cp >= lo && cp <= hi) return true;
  return false;
}

// The stretch table answers two questions for a code point: is it a letter, and which script is it.
const STARTS = new Uint32Array(UTF7_STRETCHES.length / 2);
const PACKED = new Uint16Array(UTF7_STRETCHES.length / 2);
for (let i = 0; i < STARTS.length; i++) {
  STARTS[i] = UTF7_STRETCHES[2 * i];
  PACKED[i] = UTF7_STRETCHES[2 * i + 1];
}
function packedOf(cp) {
  let lo = 0;
  let hi = STARTS.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (STARTS[mid] <= cp) lo = mid;
    else hi = mid - 1;
  }
  return PACKED[lo];
}
const isLetter = (cp) => (packedOf(cp) & 1) === 1;
const scriptOf = (cp) => packedOf(cp) >> 1;

// True for a character the scan itself reads as ASCII before it matches: one of its folded views turns it
// into ASCII. A character a fold deletes is nothing, not ASCII.
const FOLDS = new Map();
const ASCII_ONLY = /^[\x00-\x7f]+$/;
function foldsToAscii(cp) {
  let hit = FOLDS.get(cp);
  if (hit === undefined) {
    const ch = String.fromCodePoint(cp);
    hit = [
      replaceHomoglyphs(normalizeUnicode(stripInvisible(ch))),
      replaceHomoglyphs(stripInvisible(ch)),
      replaceLookalikes(normalizeUnicode(stripIgnorable(ch))),
      replaceLookalikes(stripIgnorable(ch)),
    ].some((r) => r !== "" && ASCII_ONLY.test(r));
    if (FOLDS.size < 4096) FOLDS.set(cp, hit);
  }
  return hit;
}

function hasAsciiStretch(cps) {
  let run = 0;
  for (const c of cps) {
    if (isNeutral(c)) continue;
    if (c < 128 || foldsToAscii(c)) {
      run += 1;
      if (run >= ASCII_STRETCH) return true;
    } else {
      run = 0;
    }
  }
  return false;
}

// The codec's decode of "+" + body + "-" as code points, a lone surrogate kept as itself. null when the codec
// refuses the run (strict mode only: with `ignore` a run it cannot finish keeps what it decoded before).
function decodeRun(body, strict) {
  const out = [];
  let bits = 0;
  let buffer = 0;
  let surrogate = 0;
  for (let k = 0; k < body.length; k++) {
    buffer = (buffer << 6) | BASE64[body.charCodeAt(k)];
    bits += 6;
    if (bits < 16) continue;
    const unit = buffer >> (bits - 16);
    bits -= 16;
    buffer &= (1 << bits) - 1;
    if (surrogate !== 0) {
      if (isLow(unit)) {
        out.push(0x10000 + ((surrogate - 0xd800) << 10) + (unit - 0xdc00));
        surrogate = 0;
        continue;
      }
      out.push(surrogate);
      surrogate = 0;
    }
    if (isHigh(unit)) surrogate = unit;
    else out.push(unit);
  }
  // The closing "-": what is left over must be a whole nothing.
  if (bits >= 6 || (bits > 0 && buffer !== 0)) return strict ? null : out;
  if (surrogate !== 0) out.push(surrogate);
  return out;
}

const SURROGATE_FREE_CHUNK = 8192;
function fromCodePoints(cps) {
  let s = "";
  for (let k = 0; k < cps.length; k += SURROGATE_FREE_CHUNK) {
    s += String.fromCodePoint(...cps.slice(k, k + SURROGATE_FREE_CHUNK));
  }
  return s;
}

// The text of one decoded run as it goes into the view, or null when the run is not text. Judged per
// character, never the whole run. The only thing removed is a lone surrogate.
function readRun(decoded) {
  if (decoded.length === 0) return null;
  if (decoded.every((c) => c < 128)) return fromCodePoints(decoded);
  const text = decoded.filter((c) => !isSurrogate(c));
  if (text.length === 0) return null;
  if (text.every((c) => c < 128 || isNeutral(c) || foldsToAscii(c))) return fromCodePoints(text);
  // Other scripts, long runs only: random base64 looking text decodes to units spread over the whole plane.
  if (text.length < 8 || text.length < 0.8 * decoded.length) return null;
  let readable = 0;
  for (const c of text) if (isLetter(c) || isNeutral(c)) readable += 1;
  if (readable / decoded.length < 0.6) return null;
  const scripts = new Map();
  let total = 0;
  for (const c of text) {
    if (c < 128 || isNeutral(c)) continue;
    const s = scriptOf(c);
    scripts.set(s, (scripts.get(s) ?? 0) + 1);
    total += 1;
  }
  if (total > 0 && Math.max(...scripts.values()) / total >= 0.8) return fromCodePoints(text);
  if (hasAsciiStretch(text)) return fromCodePoints(text);
  return null;
}

// `text` with every accepted UTF-7 run replaced by its decode, or null when no run was.
export function utf7View(text) {
  const parts = [];
  let last = 0;
  const n = text.length;
  let i = text.indexOf("+");
  while (i !== -1) {
    let end = i + 1;
    while (end < n && isBodyUnit(text.charCodeAt(end))) end += 1;
    const stop = end < n && text.charCodeAt(end) === 45 ? end + 1 : end;
    if (end - (i + 1) >= MIN_BODY) {
      const body = text.slice(i + 1, end);
      const cps = decodeRun(body, body.length < STRICT_BELOW);
      const decoded = cps === null ? null : readRun(cps);
      if (decoded !== null) {
        parts.push(text.slice(last, i), decoded);
        last = stop;
      }
    }
    i = text.indexOf("+", stop);
  }
  if (parts.length === 0) return null;
  parts.push(text.slice(last));
  return parts.join("");
}
