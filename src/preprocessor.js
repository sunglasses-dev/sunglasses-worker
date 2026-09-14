// Sunglasses Worker — preprocessor port of sunglasses/preprocessor.py (v0.4.9).
// Stage order and semantics mirror the Python pipeline; known deltas are listed
// in LIMITATIONS (exported for the /about payload).

export const LIMITATIONS = [
  "HTML entity decoding covers numeric + common named entities (Python decodes the full HTML5 named set)",
  "Python str.isprintable() is approximated for base64 segment screening",
  "JS \\w and \\b are ASCII-only; Python's match unicode letters (the pip scanner also normalizes homoglyphs first, which closes most of that gap)",
];

const HOMOGLYPHS = {
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

const LEET = {
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s",
  "7": "t", "@": "a", "$": "s", "!": "i",
};

const INVISIBLE_CHARS = new RegExp(
  "[\u200b\u200c\u200d\u200e\u200f" +  // zero-width spaces/joiners
  "\u2060\u2061\u2062\u2063\u2064" +   // word joiner, invisible operators
  "\ufeff" +                               // BOM / zero-width no-break space
  "\u00ad" +                               // soft hyphen
  "\u034f" +                               // combining grapheme joiner
  "\u061c" +                               // Arabic letter mark
  "\u2028\u2029" +                        // line/paragraph separators
  "\u{e0001}-\u{e007f}]",                 // Unicode tag characters
  "gu",
);

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  sol: "/", bsol: "\\", colon: ":", semi: ";", equals: "=", grave: "`",
  dollar: "$", percnt: "%", num: "#", lpar: "(", rpar: ")", lbrack: "[",
  rbrack: "]", lbrace: "{", rbrace: "}", vert: "|", ast: "*", plus: "+",
  comma: ",", period: ".", quest: "?", excl: "!", tilde: "~", lowbar: "_",
};

export function stripInvisible(text) {
  return text.replace(INVISIBLE_CHARS, "");
}

export function normalizeUnicode(text) {
  return text.normalize("NFKC");
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
// separated two words in Python and joined them here, and ASTRA's `gap_U1C_*`
// fixtures lost GLS-PI-017-API on exactly that.
const PY_WS = "[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028-\u2029\u202f\u205f\u3000]";
const PY_WS_RUN = new RegExp("(" + PY_WS + "{2,})");
const PY_WS_ONLY = new RegExp("^" + PY_WS + "+$");

export function collapseWhitespace(text) {
  return text.replace(/[\t\r\x0b\x0c]+/g, " ").replace(/ {2,}/g, " ").trim();
}

// Python's html module tables, extracted from the interpreter rather than
// retyped. `_invalid_charrefs` remaps the Windows-1252 range the way the
// HTML5 parser does, and `_invalid_codepoints` are dropped entirely.
const INVALID_CHARREFS = new Map(Object.entries({"0": "�", "13": "\r", "128": "€", "129": "", "130": "‚", "131": "ƒ", "132": "„", "133": "…", "134": "†", "135": "‡", "136": "ˆ", "137": "‰", "138": "Š", "139": "‹", "140": "Œ", "141": "", "142": "Ž", "143": "", "144": "", "145": "‘", "146": "’", "147": "“", "148": "”", "149": "•", "150": "–", "151": "—", "152": "˜", "153": "™", "154": "š", "155": "›", "156": "œ", "157": "", "158": "ž", "159": "Ÿ"}).map(([k, v]) => [Number(k), v]));
const INVALID_CODEPOINTS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 11, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 64976, 64977, 64978, 64979, 64980, 64981, 64982, 64983, 64984, 64985, 64986, 64987, 64988, 64989, 64990, 64991, 64992, 64993, 64994, 64995, 64996, 64997, 64998, 64999, 65000, 65001, 65002, 65003, 65004, 65005, 65006, 65007, 65534, 65535, 131070, 131071, 196606, 196607, 262142, 262143, 327678, 327679, 393214, 393215, 458750, 458751, 524286, 524287, 589822, 589823, 655358, 655359, 720894, 720895, 786430, 786431, 851966, 851967, 917502, 917503, 983038, 983039, 1048574, 1048575, 1114110, 1114111]);

// THE SEMICOLON IS OPTIONAL, which is the whole of ASTRA's C01978 finding. This
// required one, so `&#65` stayed literal here and decoded to `A` in Python, and
// a payload written without semicolons was invisible to the port. The pattern
// and the decision order below are Python's `html.unescape`, transcribed:
//   &(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)
// Named references still resolve against the subset this port carries, and that
// subset remains a documented delta. What is no longer a delta is the numeric
// form, its optional semicolon, and its invalid code point handling.
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
    // Longest named prefix wins and the remainder is kept, which is how
    // `&notit;` becomes `\u00acit;` rather than staying whole.
    for (let x = body.length; x > 1; x--) {
      const candidate = NAMED_ENTITIES[body.slice(0, x).toLowerCase()];
      if (candidate !== undefined) return candidate + body.slice(x);
    }
    return "&" + body;
  });
}

// BYTES, THEN ONE REPLACING DECODE, which is what Python's `unquote` does. The
// fallback here decoded each contiguous escape run and, when a run held invalid
// UTF-8, left THE WHOLE RUN encoded: ASTRA's C01982 puts an invalid byte in
// front of valid encoded text, so everything after it stayed hidden from the
// scanner while Python read it as U+FFFD followed by the real words. A decoder
// that gives up on a run is a decoder an attacker can switch off with one byte.
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
    // Literal text keeps its own bytes, so a round trip cannot alter it.
    for (const b of encoder.encode(text[i])) bytes.push(b);
    i += 1;
  }
  // `fatal: false` is the replacement behaviour of Python's errors="replace".
  return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
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

function isPrintableApprox(s) {
  // Python str.isprintable(): false for control chars (incl. \n, \t), NBSP,
  // and line/paragraph separators.
  return !/[\x00-\x1f\x7f-\x9f\xa0\u2028\u2029]/.test(s);
}

export function decodeBase64Segments(text) {
  return text.replace(/[A-Za-z0-9+/]{20,}={0,2}/g, (segment) => {
    try {
      const bin = atob(segment);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes)
        .replace(/�/g, "");  // Python uses errors='ignore'
      if (decoded.length > 4 && isPrintableApprox(decoded)) return decoded;
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

const ENRICH_MAX_LEN = 2000;

// Separates the enrichment views (plain / ROT13 / reversed / shape) inside the
// normalized string — port of preprocessor.py VIEW_SEP (v0.4.3). Excerpts shown
// to humans are clamped at this boundary so a matched_text window can never
// splice decoded gibberish onto plain text. Stripped from raw input first so an
// attacker cannot plant it.
export const VIEW_SEP = "\x1e";

export function normalize(text) {
  text = text.split(VIEW_SEP).join(" ");
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
    text = decodeBase64Segments(text);
    if (text === before) break;
  }
  text = decodeLeetspeak(text);
  text = stripDelimiterPadding(text);
  text = collapseWhitespace(text);
  if (text.length <= ENRICH_MAX_LEN) {
    const rot = decodeRot13(text);
    if (rot !== text) text = text + " " + VIEW_SEP + " " + rot;
    text = text + " " + VIEW_SEP + " " + [...text].reverse().join("");
    text = text.toLowerCase();
    const shape = text.replace(/\bl(?=[a-z])/g, "i");
    if (shape !== text) text = text + " " + VIEW_SEP + " " + shape;
  } else {
    // Long inputs: reverse/shape enrichment stays OFF (Jun-9 ReDoS), but ROT13
    // enrichment is safe here — it feeds only the keyword lane (regex lane
    // matches raw text). Mirrors preprocessor.py.
    const rot = decodeRot13(text);
    if (rot !== text) text = text + " " + VIEW_SEP + " " + rot;
    text = text.toLowerCase();
  }
  return text;
}
