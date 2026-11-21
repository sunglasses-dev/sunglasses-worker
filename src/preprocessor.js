import { pinSource, pinRx, lowerPinned, nfkcPinned } from "./pinned.js";
import { HTML5_ENTITIES } from "./html5_entities.js";
// Sunglasses Worker — preprocessor port of sunglasses/preprocessor.py (v0.4.9).
// Stage order and semantics mirror the Python pipeline; known deltas are listed
// in LIMITATIONS (exported for the /about payload).

// THIS LIST IS OBSERVED CLASSES, NOT A PROOF THAT NO OTHER CLASS EXISTS.
// The third independent review round did not reject the approximations; it rejected the claim that
// what remains is completely and accurately constrained. Four corpus ID deltas
// in 13,028 full-engine pairs is not output equality, and grouping the rest by
// mechanism is a description of what has been observed rather than a bound on
// what is left. Each entry below states its REACH, meaning the count of rules a
// difference can touch, never the count it is known to change.
export const LIMITATIONS = [
  "Scope. This is a hosted approximation of the pip scanner, which is the product of record. The engine, wide, channel, policy and counterexample parity suites read 0 differences on the corpora they run. That is not output equality, and the classes listed here are the ones that have been observed rather than a proof that no other exists",
  "Word boundaries. 958 of 1,576 rules use a word boundary in a core or a guard. Where a non-ASCII letter sits next to a boundary, a result can differ from the pip scanner's. This is the reach of the difference rather than the count it changes. Measured on 19 November 2026 beside the pip scanner on 86,784 probe rows, 6,826 answer stricter and 0 answer lower",
  "Word class membership. The word class written into the compiled rules holds the same code points as the pip scanner's on a Python with Unicode 16.0.0, read against every scalar value. Under case-insensitive matching a word class outside a guard also matches a small number of characters that the pip scanner's does not. Reach is 419 rules across 433 compiled entries, being 413 rules in 424 entries plus 6 mechanism rules in 9 entries. Measured on 19 November 2026 beside the pip scanner on 65,886 probe rows, 118 answer stricter and 0 answer lower",
  "ASCII letter ranges. Closed. A character class range under case-insensitive matching matches the set the pip scanner matches, in a negated class as well. Twelve classes enumerated against every scalar agree",
  "Decimal digit shorthands. Closed. A digit shorthand matches the same code points as the pip scanner's, read against every code point and a corpus of 1,911 texts. Reach is 38 rules",
  "More findings, same decision. On some texts this hosted scan lists more findings than the pip scanner for the same text, and the decision is the same. Measured on 19 November 2026 beside the pip scanner on 14,278 probe rows, 0 decisions differ and 260 rows list more findings",
  "Stricter on some texts. On some texts this hosted scan answers stricter than the pip scanner. Measured on 19 November 2026 beside the pip scanner on 4,343 probe rows, 63 answer stricter and 0 answer lower",
  "HTML decoding. The named set is the full HTML5 set, 2,231 names, read in the order the pip scanner reads them, with an omitted semicolon permitted for the names that allow one, checked against 6,706 named-reference rows. A numeric reference, with or without its semicolon, and a reference that spells a letter or digit agree with the pip scanner across the ordinary and invalid range. One difference remains: a numeric reference of several hundred digits stays encoded here and becomes U+FFFD in Python",
  "Unicode version. This scan carries its own Unicode tables, version 16.0.0. They decide the letter, number, digit, mark, other and separator classes of a rule, which characters are assigned, and the printable test of a base64 segment. Lower case and compatibility normalization of an assigned character are computed by the runtime and are tested equal to version 16.0.0 on every assigned character. The pip scanner reads the tables of the Python it runs on, so beside a Python built against another Unicode version a result can differ",
  "Bounded search. A long single-word document is read with a bounded search, as in the pip scanner. 30 scans per minute per IP applies",
  "Lower than the pip scanner. Measured on 19 November 2026 beside the pip scanner on 152,670 probe rows, 0 answer lower. On 18 November the same rows read 671. A test in this repository reads the texts of at most 600 characters, drawn from the pip scanner's own rules and tests, that the pip scanner stops, 10,007 on 19 November 2026, and fails on a lower answer. For a decision that matters use the pip scanner",
  "Known lower answers. Outside the probe rows above, a second probe writes each of the 10,007 texts of that test in further ways. Measured on 20 November 2026 beside the pip scanner on rule set 0.6.24, this hosted scan answers lower than the pip scanner on 150 of those texts in at least one of the ways. For a decision that matters use the pip scanner",
];

export const HOMOGLYPHS = {
  "А": "A", "В": "B", "С": "C", "Е": "E",
  "Н": "H", "К": "K", "М": "M", "О": "O",
  "Р": "P", "Т": "T", "Х": "X",
  "а": "a", "е": "e", "о": "o", "р": "p",
  "с": "c", "у": "y", "х": "x",
  "І": "I", "і": "i",
  "Ї": "I", "ї": "i",
  "Є": "E", "є": "e",
  "Ґ": "G", "ґ": "g",
  "Ո": "O", "Ս": "S",
  "ქ": "K",
  "Α": "A", "Β": "B", "Ε": "E", "Η": "H",
  "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N",
  "Ο": "O", "Ρ": "P", "Τ": "T", "Χ": "X",
  "Ζ": "Z",
  "α": "a", "ε": "e", "ο": "o", "ρ": "p",
  "υ": "u",
};
// Fullwidth Latin (FF21-FF3A, FF41-FF5A) — generated, same as the Python table.
for (let i = 0; i < 26; i++) {
  HOMOGLYPHS[String.fromCharCode(0xff21 + i)] = String.fromCharCode(65 + i);
  HOMOGLYPHS[String.fromCharCode(0xff41 + i)] = String.fromCharCode(97 + i);
}

export const LEET = {
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s",
  "7": "t", "@": "a", "$": "s", "!": "i",
};

// Control characters that are neither whitespace nor escape: they are deleted before the keyword
// lane reads the text. Tab, newline, carriage return, vertical tab, form feed, the four separators
// and next line stay because a regex reads them as spaces, and escape stays because a rule matches
// it raw. Port of preprocessor.py CONTROL_RANGES.
export const CONTROL_RANGES = "\u0000-\u0008\u000e-\u001a\u007f-\u0084\u0086-\u009f";
export const CONTROL_CHARS = new RegExp("[" + CONTROL_RANGES + "]", "u");
const CONTROL_RUN = new RegExp("[" + CONTROL_RANGES + "]+", "gu");

export const INVISIBLE_CHARS = new RegExp(
  "[\u200b\u200c\u200d\u200e\u200f" +  // zero-width spaces/joiners
  "\u2060\u2061\u2062\u2063\u2064" +   // word joiner, invisible operators
  "\ufeff" +                               // BOM / zero-width no-break space
  "\u00ad" +                               // soft hyphen
  "\u034f" +                               // combining grapheme joiner
  "\u061c" +                               // Arabic letter mark
  "\u2028\u2029" +                        // line/paragraph separators
  "\u{e0001}-\u{e007f}" +                 // Unicode tag characters
  CONTROL_RANGES + "]",
  "gu",
);

export function stripInvisible(text) {
  return text.replace(INVISIBLE_CHARS, "");
}

export function normalizeUnicode(text) {
  return nfkcPinned(text);
}

export function replaceHomoglyphs(text) {
  let out = "";
  for (const c of text) out += HOMOGLYPHS[c] ?? c;
  return out;
}

export function decodeLeetspeak(text) {
  let out = "";
  for (const c of text) out += LEET[c] ?? c;
  return out;
}

// Python's whitespace set, which is not JavaScript's. Python also matches the
// four ASCII separators U+001C to U+001F and U+0085 NEXT LINE; JavaScript also
// matches U+FEFF, which Python does not. The compiled patterns are rewritten to
// this set by the compiler, and THIS FILE'S OWN regexes need it just as much:
// `stripDelimiterPadding` splits on runs of whitespace, so a gap made of U+001C
// separated two words in Python and joined them here, and the independent review's U+001C gap
// fixtures lost GLS-PI-017-API on exactly that.
const PY_WS = "[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028-\u2029\u202f\u205f\u3000]";
const PY_WS_RUN = new RegExp("(" + PY_WS + "{2,})");
const PY_WS_ONLY = new RegExp("^" + PY_WS + "+$");

// The text with each run of control characters read as one space, except where the run already
// stands next to blank space or at an edge of the text. Port of preprocessor.py controls_as_spaces.
const PY_WS_CHAR = new RegExp("^" + PY_WS + "$");
export function controlsAsSpaces(text) {
  return text.replace(CONTROL_RUN, (run, a) => {
    const b = a + run.length;
    if (a === 0 || b === text.length || PY_WS_CHAR.test(text.charAt(a - 1)) || PY_WS_CHAR.test(text.charAt(b))) return "";
    return " ";
  });
}

// Python's str.strip(): the blanks Python reads as whitespace at either end. String.prototype.trim()
// keeps U+001C, U+001D, U+001E, U+001F and U+0085 at an edge and drops U+FEFF, which Python keeps.
export function pyStrip(text) {
  let start = 0;
  let end = text.length;
  while (start < end && PY_WS_CHAR.test(text[start])) start++;
  while (end > start && PY_WS_CHAR.test(text[end - 1])) end--;
  return text.slice(start, end);
}

export function collapseWhitespace(text) {
  return pyStrip(text.replace(/[\t\r\x0b\x0c]+/g, " ").replace(/ {2,}/g, " "));
}

// Python's html module tables, extracted from the interpreter rather than
// retyped. `_invalid_charrefs` remaps the Windows-1252 range the way the
// HTML5 parser does, and `_invalid_codepoints` are dropped entirely.
const INVALID_CHARREFS = new Map(Object.entries({"0": "�", "13": "\r", "128": "€", "129": "", "130": "‚", "131": "ƒ", "132": "„", "133": "…", "134": "†", "135": "‡", "136": "ˆ", "137": "‰", "138": "Š", "139": "‹", "140": "Œ", "141": "", "142": "Ž", "143": "", "144": "", "145": "‘", "146": "’", "147": "“", "148": "”", "149": "•", "150": "–", "151": "—", "152": "˜", "153": "™", "154": "š", "155": "›", "156": "œ", "157": "", "158": "ž", "159": "Ÿ"}).map(([k, v]) => [Number(k), v]));
const INVALID_CODEPOINTS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 11, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 64976, 64977, 64978, 64979, 64980, 64981, 64982, 64983, 64984, 64985, 64986, 64987, 64988, 64989, 64990, 64991, 64992, 64993, 64994, 64995, 64996, 64997, 64998, 64999, 65000, 65001, 65002, 65003, 65004, 65005, 65006, 65007, 65534, 65535, 131070, 131071, 196606, 196607, 262142, 262143, 327678, 327679, 393214, 393215, 458750, 458751, 524286, 524287, 589822, 589823, 655358, 655359, 720894, 720895, 786430, 786431, 851966, 851967, 917502, 917503, 983038, 983039, 1048574, 1048575, 1114110, 1114111]);

// THE SEMICOLON IS OPTIONAL, which is the whole of one of the independent review's findings. This
// required one, so `&#65` stayed literal here and decoded to `A` in Python, and
// a payload written without semicolons was invisible to the port. The pattern
// and the decision order below are Python's `html.unescape`, transcribed:
//   &(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)
// Named references resolve against Python's whole html5 table (html5_entities.js), the name written
// exactly as the table keys it, with or without the semicolon as the table has it.
//
// ONE NUMERIC DELTA REMAINS and it is not closed. A reference of several hundred
// digits overflows and is left encoded here where Python returns U+FFFD.
// `Number.isFinite` returns the original reference below rather than a
// replacement character. Saying the numeric form is no longer a delta, which is
// what this comment used to say, was false for that input.
export function decodeHtmlEntities(text) {
  if (!text.includes("&")) return text;
  return text.replace(/&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/g, (m, body) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const digits = body.slice(hex ? 2 : 1).replace(/;$/, "");
      const code = parseInt(digits, hex ? 16 : 10);
      if (!Number.isFinite(code)) return m;
      if (INVALID_CHARREFS.has(code)) return INVALID_CHARREFS.get(code);
      if ((code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) return "\uFFFD";
      if (INVALID_CODEPOINTS.has(code)) return "";
      return String.fromCodePoint(code);
    }
    // The whole name as written, else its longest prefix that the table has without a semicolon, with the
    // remainder kept: `&notit;` reads as the not sign followed by `it;`. Python's html.unescape, transcribed.
    const whole = HTML5_ENTITIES.get(body);
    if (whole !== undefined) return whole;
    for (let x = body.length - 1; x > 1; x--) {
      const candidate = HTML5_ENTITIES.get(body.slice(0, x));
      if (candidate !== undefined) return candidate + body.slice(x);
    }
    return "&" + body;
  });
}

// BYTES, THEN ONE REPLACING DECODE, which is what Python's `unquote` does. The
// fallback here decoded each contiguous escape run and, when a run held invalid
// UTF-8, left THE WHOLE RUN encoded: one of the independent review's cases puts an invalid byte in
// front of valid encoded text, so everything after it stayed hidden from the
// scanner while Python read it as U+FFFD followed by the real words. A decoder
// that gives up on a run is a decoder an attacker can switch off with one byte.
// A numeric character reference that spells an ASCII letter or digit. Markup escapes (&lt; &#60; &#39;)
// are left alone on purpose: decoding them would turn every escaped code sample in a web page into live
// markup. Port of preprocessor.py decode_letter_references.
const LETTER_REFERENCE = /&#(?:[xX]0*([0-9A-Fa-f]{1,6})|0*([0-9]{1,7}));?/g;

export function decodeLetterReferences(text) {
  if (!text.includes("&#")) return text;
  return text.replace(LETTER_REFERENCE, (whole, hex, dec) => {
    const value = hex !== undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (value < 128 && /[0-9A-Za-z]/.test(String.fromCharCode(value))) return String.fromCharCode(value);
    return whole;
  });
}

export function decodeUrlEncoding(text) {
  if (!text.includes("%")) return text;
  if (!/%[0-9A-Fa-f]{2}/.test(text)) return text;
  const bytes = [];
  const encoder = new TextEncoder();
  for (let i = 0; i < text.length; ) {
    if (text[i] === "%" && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 3;
      continue;
    }
    // BY CODE POINT, not by UTF-16 unit. `text[i]` is one unit, so a literal
    // astral character was encoded as two lone surrogates and came back as two
    // replacement characters: the independent review's neutral control turns one emoji beside an
    // escape into rubbish, where Python leaves it untouched. `codePointAt` plus
    // the surrogate-aware step keeps the pair together.
    const point = text.codePointAt(i);
    const literal = String.fromCodePoint(point);
    for (const b of encoder.encode(literal)) bytes.push(b);
    i += literal.length;
  }
  // `fatal: false` is the replacement behaviour of Python's errors="replace".
  // `ignoreBOM: true` because TextDecoder otherwise EATS a leading U+FEFF, and
  // Python's unquote does not: the review's encoded-BOM control decodes to a BOM
  // followed by the text, and this returned the text alone.
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: true })
    .decode(new Uint8Array(bytes));
}

export function decodeHexEscapes(text) {
  if (!text.includes("\\x")) return text;
  return text.replace(/\\x([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

export function decodeRot13(text) {
  return text.replace(/[a-zA-Z]/g, (c) => {
    const base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}

const PRINTABLE_NOT = pinRx("[\\p{C}\\p{Z}]", "u");
function isPrintableApprox(s) {
  // Python str.isprintable(): false for every other, separator and unassigned
  // character (control, format, private use, line/paragraph/space separators)
  // except the plain ASCII space.
  return !PRINTABLE_NOT.test(s.replace(/ /g, ""));
}

// Python's b64decode (non-validating) refuses a segment whose padding cannot
// complete the last group, and the scanner then leaves that segment as written.
// JS atob() is more forgiving (it accepts unpadded input and refuses surplus
// padding), so a segment the scanner keeps could be turned into noise here and
// hide a phrase that lives in it. Decode only the segments the scanner decodes:
// one data character left over in the last group never decodes, two need both
// "=" and three need at least one; padding beyond that is ignored.
function pythonB64Bytes(segment) {
  const data = segment.replace(/=+$/, "");
  const pad = segment.length - data.length;
  const rem = data.length % 4;
  if (rem === 1 || (rem === 2 && pad < 2) || (rem === 3 && pad < 1)) return null;
  const bin = atob(data + "=".repeat((4 - rem) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// Python's errors='ignore': invalid bytes are dropped, while a genuine U+FFFD
// that was encoded in the text (EF BF BD) is kept. A strict decode keeps every
// character. When it fails the bytes are walked here, because a replacing
// decoder cannot tell a replacement character it wrote from one that was
// encoded, and removing both joins the text on either side of it.
function decodeIgnoringInvalid(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return decodeSkippingInvalid(bytes);
  }
}

// The well-formed sequences of UTF-8 (Unicode table 3-7): lead byte, the range
// of the second byte, and how many continuation bytes follow. Anything else is
// skipped one byte at a time, which drops the same bytes as skipping the
// maximal invalid prefix, because the bytes after a bad lead cannot start a
// sequence themselves.
function decodeSkippingInvalid(bytes) {
  const parts = [];
  let run = [];
  const flush = () => {
    if (run.length) { parts.push(String.fromCodePoint(...run)); run = []; }
  };
  const n = bytes.length;
  for (let i = 0; i < n;) {
    const b = bytes[i];
    let need = 0, lo = 0x80, hi = 0xbf, cp = 0;
    if (b < 0x80) { run.push(b); i += 1; if (run.length >= 4096) flush(); continue; }
    else if (b >= 0xc2 && b <= 0xdf) { need = 1; cp = b & 0x1f; }
    else if (b >= 0xe0 && b <= 0xef) {
      need = 2; cp = b & 0x0f;
      if (b === 0xe0) lo = 0xa0;
      if (b === 0xed) hi = 0x9f;
    } else if (b >= 0xf0 && b <= 0xf4) {
      need = 3; cp = b & 0x07;
      if (b === 0xf0) lo = 0x90;
      if (b === 0xf4) hi = 0x8f;
    } else { i += 1; continue; }
    let j = 1;
    for (; j <= need; j++) {
      const c = bytes[i + j];
      if (c === undefined || c < (j === 1 ? lo : 0x80) || c > (j === 1 ? hi : 0xbf)) break;
      cp = (cp << 6) | (c & 0x3f);
    }
    if (j > need) { run.push(cp); i += need + 1; if (run.length >= 4096) flush(); }
    else i += 1;
  }
  flush();
  return parts.join("");
}

// `record`, when given, is a list that each replaced segment is appended to
// (port of preprocessor.py decode_base64_segments, scanner #345). A caller that
// needs to know whether the pipeline decoded anything asks the pipeline.
export function decodeBase64Segments(text, record) {
  return text.replace(/[A-Za-z0-9+/]{20,}={0,2}/g, (segment) => {
    try {
      const bytes = pythonB64Bytes(segment);
      if (bytes) {
        const decoded = decodeIgnoringInvalid(bytes);
        if (codePointLength(decoded) > 4 && isPrintableApprox(decoded)) {
          if (record) record.push(segment);
          return decoded;
        }
      }
    } catch { /* not base64 */ }
    return segment;
  });
}

// Both collapse rules bottom out at THREE letters (port of preprocessor.py).
// They used to require 5 (dotted) / 4 (spaced), which left a hole: splitting one
// SHORT word was enough to break a phrase match — "ignore a l l previous
// instructions" normalized with "a l l" intact and matched nothing. Two-letter
// groups ("e.g", "U S") stay untouched; those are ordinary prose.
export function stripDelimiterPadding(text) {
  text = text.replace(
    /\b([a-zA-Z])[.\-_]([a-zA-Z])(?:[.\-_][a-zA-Z])+\b/g,
    (m) => m.replace(/[.\-_]/g, ""),
  );
  const parts = text.split(PY_WS_RUN);
  const out = [];
  for (const part of parts) {
    if (PY_WS_ONLY.test(part) && part.length >= 2) {
      out.push(" ");
    } else {
      out.push(part.replace(/(?<!\w)(?:[a-zA-Z] ){2,}[a-zA-Z](?!\w)/g, (m) => m.replace(/ /g, "")));
    }
  }
  return out.join("");
}

export const ENRICH_MAX_LEN = 2000;

// Length in code points, the unit the scanner's length gates count in.
export function codePointLength(text) {
  let n = text.length;
  for (let i = 0; i + 1 < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { n--; i++; }
    }
  }
  return n;
}

// Separates the enrichment views (plain / ROT13 / reversed / shape) inside the
// normalized string — port of preprocessor.py VIEW_SEP (v0.4.3). Excerpts shown
// to humans are clamped at this boundary so a matched_text window can never
// splice decoded gibberish onto plain text. Stripped from raw input first so an
// attacker cannot plant it.
export const VIEW_SEP = "\x1e";

export function normalize(text) {
  return normalizeWithLength(text)[0];
}

// normalize(), plus the length of the folded plain text that the enrichment
// gate measured: after every fold and before any view is appended (port of
// preprocessor.py normalize_with_length, scanner #345). `record`, when given,
// is a list that each base64 blob the pipeline replaced is appended to, in the
// plain view and in the shadow view's own pipeline. It changes nothing else.
// The scanner's record also carries a marker for the HTML step giving up on the
// whole input; this port's HTML step has no such fallback, so there is none.
export function normalizeWithLength(text, record) {
  text = text.split(VIEW_SEP).join(" ");
  // Read before stripInvisible removes them, so the plain view still loses
  // them (a split phrase keeps matching) and the shadow view sees the text.
  // Mirrors preprocessor.py normalize().
  const shadow = decodeShadowAscii(text);
  // Control characters are deleted below, so a phrase they stand inside reads as written. The same text with each
  // control read as a space is kept as a view of its own, behind the separator, and decoded on its
  // original boundaries (port of preprocessor.py).
  let spaced = CONTROL_CHARS.test(text) ? controlsAsSpaces(text) : null;
  // Every control stands next to blank space: the view would repeat the plain one.
  if (spaced !== null && spaced === text.replace(CONTROL_RUN, "")) spaced = null;
  text = stripInvisible(text);
  text = normalizeUnicode(text);
  text = replaceHomoglyphs(text);
  // Iteratively unwrap LAYERED encodings — base64(base64(...)) etc. (mirrors
  // preprocessor.py). Loop until stable, capped; clean text breaks after one
  // pass so the common case pays no extra cost.
  const DECODE_MAX_PASSES = 3;
  for (let i = 0; i < DECODE_MAX_PASSES; i++) {
    const before = text;
    text = decodeHtmlEntities(text);
    text = decodeUrlEncoding(text);
    text = decodeHexEscapes(text);
    text = decodeBase64Segments(text, record);
    if (text === before) break;
  }
  text = decodeLeetspeak(text);
  text = stripDelimiterPadding(text);
  text = collapseWhitespace(text);
  const foldedLength = codePointLength(text);
  if (foldedLength <= ENRICH_MAX_LEN) {
    const rot = decodeRot13(text);
    if (rot !== text) text = text + " " + VIEW_SEP + " " + rot;
    text = text + " " + VIEW_SEP + " " + [...text].reverse().join("");
    text = lowerPinned(text);
    const shape = text.replace(/\bl(?=[a-z])/g, "i");
    if (shape !== text) text = text + " " + VIEW_SEP + " " + shape;
  } else {
    // Long inputs: reverse/shape enrichment stays OFF (Jun-9 ReDoS), but ROT13
    // enrichment is safe here — it feeds only the keyword lane (regex lane
    // matches raw text). Mirrors preprocessor.py.
    const rot = decodeRot13(text);
    if (rot !== text) text = text + " " + VIEW_SEP + " " + rot;
    text = lowerPinned(text);
  }
  if (spaced !== null) text = text + " " + VIEW_SEP + " " + normalize(spaced);
  if (shadow !== null) {
    // Its own views, behind the separator, so an excerpt never joins it to the
    // plain text.
    text = text + " " + VIEW_SEP + " " + normalizeWithLength(shadow, record)[0];
  }
  return [text, foldedLength];
}

// Invisible code points that shadow printable ASCII one for one. Port of
// preprocessor.py SHADOW_ASCII; the `u` flag makes the class code points, not
// UTF-16 halves.
const SHADOW_ASCII = /[\u{E0020}-\u{E007E}]/u;
const SHADOW_ASCII_ALL = /[\u{E0020}-\u{E007E}]/gu;

// The input with each shadow code point read as the ASCII it shadows. null
// when there is none, so ordinary text gains no extra view.
export function decodeShadowAscii(text) {
  if (!SHADOW_ASCII.test(text)) return null;
  return text.replace(SHADOW_ASCII_ALL, (c) => String.fromCodePoint(c.codePointAt(0) - 0xE0000));
}

// ── The regex lane's widened folded view ─────────────────────────────────────────────
// Every code point that renders as nothing, written out as ranges so the set is the same on
// every runtime. It is the Unicode Default_Ignorable_Code_Point property, plus the format
// characters that renderers do not draw either, plus INVISIBLE_CHARS above. Port of
// preprocessor.py IGNORABLE_RANGES.
export const IGNORABLE_RANGES = [
  [0x0000, 0x0008], [0x000E, 0x001A], [0x007F, 0x0084], [0x0086, 0x009F], [0x00AD, 0x00AD],
  [0x034F, 0x034F], [0x061C, 0x061C], [0x115F, 0x1160], [0x17B4, 0x17B5], [0x180B, 0x180F],
  [0x200B, 0x200F], [0x2028, 0x2029], [0x202A, 0x202E], [0x2060, 0x206F], [0x3164, 0x3164],
  [0xFE00, 0xFE0F], [0xFEFF, 0xFEFF], [0xFFA0, 0xFFA0], [0xFFF0, 0xFFFB], [0x13430, 0x1343F],
  [0x1BCA0, 0x1BCA3], [0x1D173, 0x1D17A], [0xE0000, 0xE0FFF],
];
const hex = (c) => "\\u{" + c.toString(16) + "}";
const IGNORABLE_CLASS = IGNORABLE_RANGES.map(([lo, hi]) => (lo === hi ? hex(lo) : hex(lo) + "-" + hex(hi))).join("");
const IGNORABLE_CHARS = new RegExp("[" + IGNORABLE_CLASS + "]+", "gu");
const IGNORABLE_BETWEEN_BRAILLE = new RegExp("(?<=[\\u2800-\\u28ff])[" + IGNORABLE_CLASS + "]+(?=[\\u2800-\\u28ff])", "gu");

// Punctuation that looks like an ASCII sign and that NFKC does not map, and the characters drawn as
// a blank that a literal space does not match. Each entry is one code point to one code point.
// Port of preprocessor.py PUNCT_LOOKALIKES and BLANKS.
const PUNCT_LOOKALIKES = {
  "‐": "-", "‑": "-", "‒": "-", "⁃": "-", "−": "-", "˗": "-",
  "¦": "|", "❘": "|", "∣": "|", "ǀ": "|", "⏐": "|",
  "∕": "/", "⁄": "/", "⧸": "/",
  "꞉": ":", "˸": ":", "∶": ":",
};
const BLANKS = { "⠀": " ", "\u0085": " ", " ": " " };
const LOOKALIKES = { ...HOMOGLYPHS, ...PUNCT_LOOKALIKES, ...BLANKS };

// A letter is ASCII or one the homoglyph table maps to ASCII.
const WORD_CHAR_CLASS = "A-Za-z0-9" + Object.keys(HOMOGLYPHS).map((c) => hex(c.codePointAt(0))).join("");
const IGNORABLE_BETWEEN_WORDS = new RegExp("(?<=[" + WORD_CHAR_CLASS + "])[" + IGNORABLE_CLASS + "]+(?=[" + WORD_CHAR_CLASS + "])", "gu");

// ── The walk's reading of the widened fold (negation.js Walk.widened) ─────────────────────────────
// Port of preprocessor.py's use of IGNORABLE_CHARS, PUNCT_LOOKALIKES, BLANKS, WORD_CHAR, decoded_before
// and decoded_at by engine.py _Walk._widened.
const IGNORABLE_STICKY = new RegExp("[" + IGNORABLE_CLASS + "]+", "uy");
const IGNORABLE_ONE_CP = new RegExp("^[" + IGNORABLE_CLASS + "]$", "u");
const WORD_CHAR_ONE = new RegExp("^[" + WORD_CHAR_CLASS + "]$", "u");

// End of the run of ignorable code points that starts at text[at], or -1 when text[at] is not one.
export function ignorableRunEnd(text, at) {
  IGNORABLE_STICKY.lastIndex = at;
  return IGNORABLE_STICKY.test(text) ? IGNORABLE_STICKY.lastIndex : -1;
}

// True when `ch` (one code point, or "") is an ignorable code point / a letter or digit the fold reads.
export const isIgnorableChar = (ch) => ch !== "" && IGNORABLE_ONE_CP.test(ch);
export const isWordChar = (ch) => ch !== "" && WORD_CHAR_ONE.test(ch);

// The ASCII character a punctuation look-alike or a blank-drawn character is mapped to, else undefined.
export const lookalikeOf = (ch) => PUNCT_LOOKALIKES[ch] ?? BLANKS[ch];

const REFERENCE_TAIL = new Set("0123456789abcdefABCDEFxX;");
const LETTER_REFERENCE_AT = /&#(?:[xX]0*([0-9A-Fa-f]{1,6})|0*([0-9]{1,7}));?/y;
function letterReferenceAt(text, at) {
  LETTER_REFERENCE_AT.lastIndex = at;
  const m = LETTER_REFERENCE_AT.exec(text);
  if (m === null) return null;
  const value = m[1] !== undefined ? parseInt(m[1], 16) : parseInt(m[2], 10);
  const letter = value < 128 && /[0-9A-Za-z]/.test(String.fromCharCode(value)) ? String.fromCharCode(value) : m[0];
  return { end: at + m[0].length, text: letter };
}

// The code point that decodeLetterReferences(text) holds just before what text[pos] becomes, or "".
export function decodedBefore(text, pos) {
  let k = pos;
  while (k > 0 && REFERENCE_TAIL.has(text[k - 1])) k--;
  if (k >= 2 && text.startsWith("&#", k - 2)) {
    const ref = letterReferenceAt(text, k - 2);
    if (ref !== null && ref.end === pos) return Array.from(ref.text).pop();
  }
  if (pos <= 0) return "";
  const last = text.charCodeAt(pos - 1);
  return last >= 0xdc00 && last <= 0xdfff && pos >= 2 ? text.slice(pos - 2, pos) : text[pos - 1];
}

// The first code point that decodeLetterReferences makes of text[pos:], or "" at the end.
export function decodedAt(text, pos) {
  if (text.startsWith("&#", pos)) {
    const ref = letterReferenceAt(text, pos);
    if (ref !== null) return Array.from(ref.text)[0];
  }
  return pos < text.length ? String.fromCodePoint(text.codePointAt(pos)) : "";
}

// Delete every code point that renders as nothing, except that a run of them between two Braille
// cells is read as one space.
export function stripIgnorable(text) {
  return text.replace(IGNORABLE_BETWEEN_BRAILLE, " ").replace(IGNORABLE_CHARS, "");
}

// The text with each ignorable run that sits between two letters or digits read as one space.
// null when there is no such run.
export function spaceIgnorableBetweenWords(text) {
  let count = 0;
  const spaced = text.replace(IGNORABLE_BETWEEN_WORDS, () => { count++; return " "; });
  return count > 0 ? spaced : null;
}

// Homoglyph letters, punctuation look-alikes and blanks to their ASCII character; one code point to
// one code point.
export function replaceLookalikes(text) {
  let out = "";
  for (const c of text) out += LOOKALIKES[c] ?? c;
  return out;
}

// The ignorable-run reading for the keyword lane, whose cover checks read where a line ends: a run
// that holds one of `lineBreaks` is read as the line break it is drawn as, any other run as one space.
// null when there is no run between two letters or digits. Port of preprocessor.py keyword_view_between_words.
export function keywordViewBetweenWords(text, lineBreaks) {
  const breaks = new Set(lineBreaks);
  let count = 0;
  const view = text.replace(IGNORABLE_BETWEEN_WORDS, (run) => {
    count++;
    for (const c of run) if (breaks.has(c)) return "\n";
    return " ";
  });
  return count > 0 ? view : null;
}

// The digits a Python \d matches: every code point of general category Nd in the Unicode version of the
// Python the scanner runs on. A JavaScript \d matches 0-9 only, so a rule that reads a number reads the
// same number written in any other script as Python does. Listed by range, because an engine's own \p{Nd}
// follows its own Unicode version and would add digits Python does not have.
const PY_DIGIT_RANGES = [
  [0x30, 0x39], [0x660, 0x669], [0x6f0, 0x6f9], [0x7c0, 0x7c9], [0x966, 0x96f], [0x9e6, 0x9ef],
  [0xa66, 0xa6f], [0xae6, 0xaef], [0xb66, 0xb6f], [0xbe6, 0xbef], [0xc66, 0xc6f], [0xce6, 0xcef],
  [0xd66, 0xd6f], [0xde6, 0xdef], [0xe50, 0xe59], [0xed0, 0xed9], [0xf20, 0xf29], [0x1040, 0x1049],
  [0x1090, 0x1099], [0x17e0, 0x17e9], [0x1810, 0x1819], [0x1946, 0x194f], [0x19d0, 0x19d9], [0x1a80, 0x1a89],
  [0x1a90, 0x1a99], [0x1b50, 0x1b59], [0x1bb0, 0x1bb9], [0x1c40, 0x1c49], [0x1c50, 0x1c59], [0xa620, 0xa629],
  [0xa8d0, 0xa8d9], [0xa900, 0xa909], [0xa9d0, 0xa9d9], [0xa9f0, 0xa9f9], [0xaa50, 0xaa59], [0xabf0, 0xabf9],
  [0xff10, 0xff19], [0x104a0, 0x104a9], [0x10d30, 0x10d39], [0x10d40, 0x10d49], [0x11066, 0x1106f],
  [0x110f0, 0x110f9], [0x11136, 0x1113f], [0x111d0, 0x111d9], [0x112f0, 0x112f9], [0x11450, 0x11459],
  [0x114d0, 0x114d9], [0x11650, 0x11659], [0x116c0, 0x116c9], [0x116d0, 0x116e3], [0x11730, 0x11739],
  [0x118e0, 0x118e9], [0x11950, 0x11959], [0x11bf0, 0x11bf9], [0x11c50, 0x11c59], [0x11d50, 0x11d59],
  [0x11da0, 0x11da9], [0x11f50, 0x11f59], [0x16130, 0x16139], [0x16a60, 0x16a69], [0x16ac0, 0x16ac9],
  [0x16b50, 0x16b59], [0x16d70, 0x16d79], [0x1ccf0, 0x1ccf9], [0x1d7ce, 0x1d7ff], [0x1e140, 0x1e149],
  [0x1e2f0, 0x1e2f9], [0x1e4f0, 0x1e4f9], [0x1e5f1, 0x1e5fa], [0x1e950, 0x1e959], [0x1fbf0, 0x1fbf9],
];
const PY_DIGIT_BODY = PY_DIGIT_RANGES.map(([lo, hi]) => (lo === hi ? "\\u{" + lo.toString(16) + "}" : "\\u{" + lo.toString(16) + "}-\\u{" + hi.toString(16) + "}")).join("");

// A rule's regex source with each \d outside a class written as the class of those digits and each \d
// inside a class written as their ranges, an escaped backslash left as it is. \D outside a class is the
// complement class. The \u{...} form needs flag u; every compiled rule carries it.
export function withPythonDigits(source) {
  source = pinSource(source);   // \p{...} first: the pinned tables, never the engine's own
  if (!source.includes("\\d") && !source.includes("\\D")) return source;
  let out = "";
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      const n = source[i + 1];
      if (n === "d") out += inClass ? PY_DIGIT_BODY : "[" + PY_DIGIT_BODY + "]";
      else if (n === "D") {
        if (inClass) throw new Error("a \\D inside a class has no class form here");
        out += "[^" + PY_DIGIT_BODY + "]";
      } else out += c + (n === undefined ? "" : n);
      i++;
      continue;
    }
    if (!inClass && c === "[") inClass = true;
    else if (inClass && c === "]") inClass = false;
    out += c;
  }
  return out;
}
