// Sunglasses Worker — preprocessor port of sunglasses/preprocessor.py (v0.2.73).
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

export function collapseWhitespace(text) {
  return text.replace(/[\t\r\x0b\x0c]+/g, " ").replace(/ {2,}/g, " ").trim();
}

export function decodeHtmlEntities(text) {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return m; }
      }
      return m;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

export function decodeUrlEncoding(text) {
  if (!text.includes("%")) return text;
  if (!/%[0-9A-Fa-f]{2}/.test(text)) return text;
  // Python's unquote never throws on malformed input; decode leniently.
  try {
    return decodeURIComponent(text);
  } catch {
    return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (seq) => {
      try { return decodeURIComponent(seq); } catch { return seq; }
    });
  }
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

export function stripDelimiterPadding(text) {
  text = text.replace(
    /\b([a-zA-Z])[.\-_]([a-zA-Z])[.\-_]([a-zA-Z])([.\-_][a-zA-Z]){2,}\b/g,
    (m) => m.replace(/[.\-_]/g, ""),
  );
  const parts = text.split(/(\s{2,})/);
  const out = [];
  for (const part of parts) {
    if (/^\s+$/.test(part) && part.length >= 2) {
      out.push(" ");
    } else {
      out.push(part.replace(/(?<!\w)(?:[a-zA-Z] ){3,}[a-zA-Z](?!\w)/g, (m) => m.replace(/ /g, "")));
    }
  }
  return out.join("");
}

const ENRICH_MAX_LEN = 2000;

export function normalize(text) {
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
    if (rot !== text) text = text + " " + rot;
    text = text + " " + [...text].reverse().join("");
    text = text.toLowerCase();
    const shape = text.replace(/\bl(?=[a-z])/g, "i");
    if (shape !== text) text = text + " " + shape;
  } else {
    // Long inputs: reverse/shape enrichment stays OFF (Jun-9 ReDoS), but ROT13
    // enrichment is safe here — it feeds only the keyword lane (regex lane
    // matches raw text). Mirrors preprocessor.py.
    const rot = decodeRot13(text);
    if (rot !== text) text = text + " " + rot;
    text = text.toLowerCase();
  }
  return text;
}
