import { pinRx } from "./pinned.js";
// Text helpers that read a string the way the pip scanner's interpreter does, for the structural validators.
// A JavaScript string is a list of UTF-16 units and Python's is a list of code points; white space, line breaks
// and decimal digits are not the same sets either. Each helper here names the Python call it stands for.

// str.isspace(): the characters \s matches in a Python pattern, as a class body.
export const PY_SPACE = "\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const SPACE_END = new RegExp(`[${PY_SPACE}]+$`);
const SPACE_START = new RegExp(`^[${PY_SPACE}]+`);
const SPACE_RUN = new RegExp(`[${PY_SPACE}]+`);

// The first code point of each run of ten decimal digits (Unicode Nd), Unicode 16.
const ND_ZEROS = [
  0x30, 0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66, 0xde6, 0xe50, 0xed0,
  0xf20, 0x1040, 0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0, 0x1c40, 0x1c50, 0xa620,
  0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0, 0xff10, 0x104a0, 0x10d30, 0x10d40, 0x11066, 0x110f0, 0x11136,
  0x111d0, 0x112f0, 0x11450, 0x114d0, 0x11650, 0x116c0, 0x116d0, 0x116da, 0x11730, 0x118e0, 0x11950, 0x11bf0,
  0x11c50, 0x11d50, 0x11da0, 0x11f50, 0x16130, 0x16a60, 0x16ac0, 0x16b50, 0x16d70, 0x1ccf0, 0x1d7ce, 0x1d7d8,
  0x1d7e2, 0x1d7ec, 0x1d7f6, 0x1e140, 0x1e2f0, 0x1e4f0, 0x1e5f1, 0x1e950, 0x1fbf0,
];

// The value of a decimal digit character (int("٣") is 3), or -1 when it is none.
export function digitValue(cp) {
  let lo = 0;
  let hi = ND_ZEROS.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ND_ZEROS[mid] <= cp) lo = mid;
    else hi = mid - 1;
  }
  const v = cp - ND_ZEROS[lo];
  return v >= 0 && v <= 9 ? v : -1;
}

// int(text) for text that is only decimal digits of any script (what \d+ matches).
export function pyDigitsToInt(text) {
  let out = 0;
  for (const ch of text) out = out * 10 + digitValue(ch.codePointAt(0));
  return out;
}

// text.strip()
export function pyStrip(text) {
  return text.replace(SPACE_START, "").replace(SPACE_END, "");
}
export function pyLstrip(text) {
  return text.replace(SPACE_START, "");
}

// text.split(None, 1)[0] for a text that is not empty after strip
export function pyFirstWord(text) {
  const t = pyLstrip(text);
  const m = SPACE_RUN.exec(t);
  return m === null ? t : t.slice(0, m.index);
}

// text.splitlines()
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;
export function pySplitlines(text) {
  if (text === "") return [];
  const parts = text.split(new RegExp(LINE_BREAK.source, "g"));
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

// The first n code points
export function cpHead(s, n) {
  if (s.length <= n) return s;
  let i = 0;
  let seen = 0;
  while (i < s.length && seen < n) {
    const c = s.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00 ? 2 : 1;
    seen += 1;
  }
  return s.slice(0, i);
}

// len(text) in code points
export function cpLength(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) i += 1;
    n += 1;
  }
  return n;
}

// The length of text in UTF-8 bytes, a lone surrogate counted as three as Python's surrogatepass writes it.
const NON_ASCII = /[^\x00-\x7f]/;
export function utf8Size(text) {
  if (!NON_ASCII.test(text)) return text.length;
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i += 1;
    } else n += 3;
  }
  return n;
}

export function charSize(cp) {
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

export const isAscii = (text) => !NON_ASCII.test(text);

// bisect.bisect_left / bisect_right on a sorted list of numbers
export function bisectLeft(a, x) {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
export function bisectRight(a, x) {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (x < a[mid]) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// urllib.parse.unquote(text): %XX runs are bytes read as UTF-8, a byte that is not valid becomes U+FFFD.
const PERCENT_RUN = /(?:%[0-9a-fA-F]{2})+/g;
export function pyUnquote(text) {
  if (!text.includes("%")) return text;
  return text.replace(PERCENT_RUN, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(run.slice(3 * i + 1, 3 * i + 3), 16);
    return new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes);
  });
}

// float(text) succeeds
const D = "\\p{Nd}";
const DIGITPART = `${D}(?:_?${D})*`;
const FLOAT_OK = pinRx(
  `^[${PY_SPACE}]*[+-]?(?:inf|infinity|nan|(?:${DIGITPART}(?:\\.(?:${DIGITPART})?)?|\\.${DIGITPART})(?:e[+-]?${DIGITPART})?)[${PY_SPACE}]*$`,
  "iu",
);
export const pyFloatOk = (text) => FLOAT_OK.test(text);

// int(text, base) succeeds, for base 2, 8, 10 or 16
export function pyIntOk(text, base) {
  const m = new RegExp(`^[${PY_SPACE}]*[+-]?(.*?)[${PY_SPACE}]*$`, "su").exec(text);
  if (m === null) return false;
  let body = m[1];
  const prefix = { 2: /^0[bB]/, 8: /^0[oO]/, 16: /^0[xX]/ }[base];
  if (prefix !== undefined && prefix.test(body)) {
    body = body.slice(2);
    if (body.startsWith("_")) body = body.slice(1);
  }
  if (body === "") return false;
  const digit = (ch) => {
    const cp = ch.codePointAt(0);
    const v = digitValue(cp);
    if (v >= 0) return v < base ? v : -1;
    if (base === 16) {
      if (cp >= 0x30 && cp <= 0x39) return cp - 0x30;
      if (cp >= 0x41 && cp <= 0x46) return cp - 0x41 + 10;
      if (cp >= 0x61 && cp <= 0x66) return cp - 0x61 + 10;
    }
    return -1;
  };
  let afterDigit = false;
  for (const ch of body) {
    if (ch === "_") {
      if (!afterDigit) return false;
      afterDigit = false;
      continue;
    }
    if (digit(ch) < 0) return false;
    afterDigit = true;
  }
  return afterDigit;
}

// str.isdigit(): decimal digits and the digits that are not decimal (superscripts, circled digits).
export const PY_ISDIGIT = pinRx(String.raw`^[\p{Nd}\u00b2-\u00b3\u00b9\u1369-\u1371\u19da\u2070\u2074-\u2079\u2080-\u2089\u2460-\u2468\u2474-\u247c\u2488-\u2490\u24ea\u24f5-\u24fd\u24ff\u2776-\u277e\u2780-\u2788\u278a-\u2792\u{10a40}-\u{10a43}\u{10e60}-\u{10e68}\u{11052}-\u{1105a}\u{1f100}-\u{1f10a}]+$`, "u");
