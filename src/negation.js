// Negation and framing context: when a hit is a warning or a description and
// not an instruction. Port of the scanner's engine.py `_check_negation`,
// `_is_defensively_framed`, `_Walk` and `_RawAlign` (0.6.8: #345, #347, #361).
//
// A cue ("do not", "never", "Example:", "this scanner detects") downgrades a hit
// only when it GOVERNS the clause the hit sits in. The gap between the cue and
// the hit is judged by an allowlist of plain words, not by a list of bad
// characters, and in every view of the input but the raw text itself the cue,
// the gap and the start of the hit must be the same characters at the same
// place in the raw input, so a gap made by decoding, erasing or folding
// characters never governs.
//
// WHERE THIS PORT IS NARROWER THAN THE SCANNER, ON PURPOSE. The scanner's walk
// pairs a view with the raw input through decoding steps (an entity, a percent
// escape, a hex escape, a shadow tag) and vouches for the text after them. This
// walk stops at the first place the pipeline decodes anything, or could have
// decoded a base64 blob, and vouches for nothing past it. A walk that stops
// early can only fail to downgrade a hit, never downgrade one the scanner would
// not. Where the scanner would vouch past a decoded escape this port reports the
// hit at its plain severity.
import {
  HOMOGLYPHS, INVISIBLE_CHARS, LEET, VIEW_SEP, ENRICH_MAX_LEN,
  decodeHexEscapes, decodeHtmlEntities, decodeRot13, decodeShadowAscii,
  decodeUrlEncoding, normalizeUnicode, replaceHomoglyphs, stripInvisible,
} from "./preprocessor.js";

export const NEGATION_WINDOW = 50;
export const NEGATION_GAP_WORDS = 2;
export const NEGATION_QUOTED_GAP_WORDS = 3;
export const DEFENSIVE_WINDOW = 120;
export const DEFENSIVE_GAP_WORDS = 6;
export const DEFENSIVE_QUOTED_GAP_WORDS = 3;
// The longest run of plain spaces that a caller may read as the one space it
// collapsed to; a longer run hides how far apart the words are.
export const BLANK_RUN = 8;
const SEP = " " + VIEW_SEP + " ";

const TRUE_NEGATIONS = [
  "do not", "don't", "don't", "dont",
  "never", "avoid", "be careful", "watch out for",
  "beware of", "not run", "not execute", "not use",
  "should not", "shouldn't", "shouldn't",
  "must not", "must never",
];
const FRAMING_LABELS = [
  "warning:", "warning -", "example of", "example:",
  "for example", "caution:", "note:",
];
const DEFENSIVE_FRAMING = [
  "detect", "detects", "detecting", "detection",
  "scan for", "scans for", "scanning for",
  "protect against", "protects against", "protection against",
  "defend against", "defends against",
  "block", "blocks", "prevent", "prevents",
  "flag", "flags", "catch", "catches", "identifies",
  "attempts to", "attempt to", "tries to",
  "attackers", "adversaries", "malicious actors", "threat actors",
  "vulnerability", "vulnerabilities", "exploit", "cve-",
];
const QUOTE_CLOSERS = {
  "```": "```", '"': '"', "“": "”", "«": "»", "‘": "’",
  "'": "'", "`": "`", "「": "」", "『": "』",
};
const NEGATION_CLAUSE_WORDS = new Set(["then", "now", "but", "so", "instead", "and", "or"]);
const NEGATION_FLIP_WORDS = new Set([
  "hesitate", "fail", "forget", "refuse", "neglect", "omit", "skip", "miss"]);
const DEFENSIVE_BREAK_WORDS = new Set([
  "then", "now", "but", "so", "instead", "however",
  "you", "your", "yours", "yourself"]);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const W = "\\p{L}\\p{N}_";   // Python's \w
// Python's str.isspace() and the blanks its \s reads.
const PY_WS = "\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const OPENERS = "```|[\"“«‘'`「『]";
const WORD = "[a-z0-9]+(?:-[a-z0-9]+)*";
const WORDS = `${WORD}(?: ${WORD})*`;

const NEGATION_RX = new RegExp(
  `(?<![${W}'’])(?:${TRUE_NEGATIONS.map(escapeRe).join("|")})(?![${W}'’])`, "gu");
const GAP_SPACES_RX = new RegExp(`(?<=[a-z0-9]) {2,${BLANK_RUN}}(?=[a-z0-9])`, "g");
const GAP_FULL_RX = new RegExp(`^(?: ?(?:${WORDS} ?)?)$`);
const LABEL_OPENER_RX = new RegExp(`^[${PY_WS}]*(?:${OPENERS})[${PY_WS}]*$`);
const QUOTED_GAP_RX = new RegExp(`^(?: ?(?:(?<words>${WORDS})(?::[ ]?| ))?(?<open>${OPENERS})[ ]?)$`);
const DEFENSIVE_RX = new RegExp(
  `(?<![${W}])(?:` +
  [...DEFENSIVE_FRAMING].sort((a, b) => b.length - a.length)
    .map((p) => escapeRe(p) + (p.endsWith("-") ? "" : `(?![${W}])`)).join("|") + ")", "gu");
const DEFENSIVE_EXAMPLE_RX = new RegExp(
  `^(?:(?<lead>[a-z0-9 -]*(?<![a-z0-9])(?:such as|for example|for instance)): ?(?<rest>[a-z0-9 -]*))$`);
const DEFENSIVE_PAREN_RX = new RegExp(
  `^(?: ?(?<pre>${WORDS})?, ?(?<par>${WORD}(?: ${WORD}){0,2}), ?(?<post>${WORDS})? ?)$`);
const DEFENSIVE_QUOTED_GAP_RX = new RegExp(
  `^(?: ?(?:(?<words>${WORDS})(?::[ ]?| ))?(?<open>${OPENERS})[ ]?)`);

const ALNUM = /^[\p{L}\p{N}]$/u;
export const isAlnum = (ch) => ch !== undefined && ch !== "" && ALNUM.test(ch);

// The whole code point that ends just before index i, or starts at index i. A
// neighbour test reads a character, and a character outside the BMP is two
// UTF-16 units; reading one unit would test half of it.
export const cpBefore = (text, i) => {
  if (i < 1) return undefined;
  const lo = text.charCodeAt(i - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) {
    const hi = text.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return text.slice(i - 2, i);
  }
  return text[i - 1];
};
export const cpAt = (text, i) => {
  if (i >= text.length) return undefined;
  const hi = text.charCodeAt(i);
  if (hi >= 0xd800 && hi <= 0xdbff && i + 1 < text.length) {
    const lo = text.charCodeAt(i + 1);
    if (lo >= 0xdc00 && lo <= 0xdfff) return text.slice(i, i + 2);
  }
  return text[i];
};

// The index n code points before / after index i, kept inside the text. The
// scanner's windows and neighbour steps count code points; an index here counts
// UTF-16 units, so a window of n characters is walked, not subtracted.
export function cpBack(text, i, n) {
  while (n > 0 && i > 0) {
    i--;
    if (i > 0) {
      const lo = text.charCodeAt(i);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        const hi = text.charCodeAt(i - 1);
        if (hi >= 0xd800 && hi <= 0xdbff) i--;
      }
    }
    n--;
  }
  return i;
}
export function cpFwd(text, i, n) {
  while (n > 0 && i < text.length) {
    const hi = text.charCodeAt(i);
    i++;
    if (hi >= 0xd800 && hi <= 0xdbff && i < text.length) {
      const lo = text.charCodeAt(i);
      if (lo >= 0xdc00 && lo <= 0xdfff) i++;
    }
    n--;
  }
  return i;
}

export function asciiLower(text) {
  return text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

// Python's str.isspace().
export function isPySpace(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 0x09 && c <= 0x0d) || (c >= 0x1c && c <= 0x20) || c === 0x85
    || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a)
    || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
}

const INVISIBLE_ONE = new RegExp("^" + INVISIBLE_CHARS.source + "$", "u");
const BLANKS = " \t\n\r\x0b\x0c";

// ── the walk ────────────────────────────────────────────────────────────────

// First code point string at index j.
const charAt = (s, j) => String.fromCodePoint(s.codePointAt(j));
const isTag = (cp) => cp >= 0xe0020 && cp <= 0xe007e;

// True when the pipeline's character steps turn the non-ASCII character c into
// text that holds the start of an escape (a full-width or small ampersand,
// percent sign or backslash).
const startCache = new Map();
function foldsToAStart(c) {
  let v = startCache.get(c);
  if (v === undefined) {
    v = /[&%\\]/.test(replaceHomoglyphs(normalizeUnicode(stripInvisible(c))));
    if (startCache.size >= 4096) startCache.clear();
    startCache.set(c, v);
  }
  return v;
}

const ENTITY_AT = /&(?:#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/y;
const PERCENT_AT = /%[0-9A-Fa-f]{2}/y;
const HEXESC_AT = /\\x[0-9A-Fa-f]{2}/y;
const UNFINISHED_ESCAPE = /^(?:&(?:#[xX]?[0-9a-fA-F]*|[A-Za-z][A-Za-z0-9]*)?|%[0-9A-Fa-f]?|\\(?:x[0-9A-Fa-f]?)?)$/;
const ESCAPE_START = /[&%\\\u{e0020}-\u{e007e}]/gu;
const GUARD_START = /[&%\\\u0080-\u{10ffff}]/gu;
const RUN_RX = /[A-Za-z0-9+/=&%\\#;\u0080-\u{10ffff}]+/gu;
const BLOB_FLOOR = 20;
const isAscii = (s) => !/[^\x00-\x7f]/.test(s);

// True when an escape the pipeline decodes begins at text[j].
function decodesAt(text, j) {
  const c = text[j];
  if (c === "&") {
    ENTITY_AT.lastIndex = j;
    const m = ENTITY_AT.exec(text);
    return m !== null && decodeHtmlEntities(m[0]) !== m[0];
  }
  if (c === "%") { PERCENT_AT.lastIndex = j; return PERCENT_AT.test(text); }
  if (c === "\\") { HEXESC_AT.lastIndex = j; return HEXESC_AT.test(text); }
  const cp = text.codePointAt(j);
  return cp !== undefined && isTag(cp);
}

// True when text[j] starts an escape that only reads as one after the
// pipeline's character steps (invisible characters removed, compatibility
// forms folded, look-alikes mapped before the entity, percent and hex passes).
function foldsToEscape(text, j) {
  const window = text.slice(j, j + 64);
  if (isAscii(window)) return false;
  const folded = replaceHomoglyphs(normalizeUnicode(stripInvisible(window)));
  if (decodesAt(folded, 0)) return true;
  // A window that ends before the escape does leaves a name that is only a
  // start. Whether it is an escape is then not known, and an unknown start is
  // treated as one.
  return j + 64 < text.length && UNFINISHED_ESCAPE.test(folded);
}

const foldOf = (text) => replaceHomoglyphs(normalizeUnicode(stripInvisible(text)));

const ENTITY_SHAPED = /&(?:#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*)/;

// The text after the pipeline's character steps and its escape passes, repeated
// until nothing changes, as normalize() does. null when an entity-shaped
// reference turns up, because this port cannot tell whether the scanner's
// larger name table decodes it.
function unwrapped(text) {
  text = foldOf(text);
  for (let n = 0; n < 3; n++) {
    if (ENTITY_SHAPED.test(text)) return null;
    const before = text;
    text = decodeHexEscapes(decodeUrlEncoding(text));
    if (text === before) break;
  }
  return ENTITY_SHAPED.test(text) ? null : text;
}

// True when the run, folded, has room for a blob. Shadow tags count as the
// ASCII they shadow.
function runCouldHoldABlob(run) {
  if (isAscii(run) && run.length < BLOB_FLOOR) return false;
  return foldOf(decodeShadowAscii(run) ?? run).length >= BLOB_FLOOR;
}

// The raw offset from which a walk vouches for nothing: the first place an
// escape the pipeline decodes begins, the start character of a reference that
// holds one, or, when the pipeline decoded a base64 blob, the first run with
// room for one.
function stopOffset(raw, record) {
  let stop = raw.length;
  let firstActive = -1;
  const candidate = /[&%\\\u0080-\u{10ffff}]/gu;
  for (let m; (m = candidate.exec(raw)) !== null;) {
    const c = m[0];
    const k = m.index;
    const isStart = c === "&" || c === "%" || c === "\\" || isTag(c.codePointAt(0))
      || (!isAscii(c) && foldsToAStart(c));
    if (isStart && (decodesAt(raw, k) || foldsToEscape(raw, k))) { firstActive = k; break; }
  }
  if (firstActive !== -1) {
    // A start character in front of that escape, in the same run of non-blank
    // text, may begin a reference the escape completes.
    let low = 0;
    for (const blank of BLANKS) {
      const at = raw.lastIndexOf(blank, firstActive - 1);
      if (at + 1 > low) low = at + 1;
    }
    stop = firstActive;
    GUARD_START.lastIndex = low;
    for (let m; (m = GUARD_START.exec(raw)) !== null && m.index < firstActive;) {
      const c = m[0];
      if (isAscii(c) || foldsToAStart(c)) { stop = m.index; break; }
    }
  }
  if (record && record.length) {
    RUN_RX.lastIndex = 0;
    for (let m; (m = RUN_RX.exec(raw)) !== null;) {
      if (m.index >= stop) break;
      if (runCouldHoldABlob(m[0])) { stop = m.index; break; }
    }
  }
  return stop;
}

// What a run of raw characters can read as after the pipeline's character
// steps: compatibility folding, look-alike mapping, leet, lowercasing.
function variants(text) {
  const out = [text];
  const folded = normalizeUnicode(text);
  for (const base of [text, folded]) {
    let mapped = "";
    for (const c of base) mapped += HOMOGLYPHS[c] ?? c;
    for (const form of [base, mapped]) {
      out.push(form, form.toLowerCase());
      if (form.includes("Σ")) {
        out.push(form.toLowerCase().replace(/σ/g, "ς"));
      }
      let leet = "";
      for (const c of form) leet += LEET[c] ?? c;
      out.push(leet, leet.toLowerCase());
      let leetLow = "";
      for (const c of form.toLowerCase()) leetLow += LEET[c] ?? c;
      out.push(leetLow);
    }
  }
  return [...new Set(out)].filter((v) => v);
}

// True when reading is the lower case of the single character c: the same
// letter from the same place, which does not take the character out of the raw
// input the way a look-alike or a leet mapping does.
function isCaseOf(c, reading) {
  if ([...reading].length !== 1 || c === reading || isAscii(c)) return false;
  if (!(reading === c.toLowerCase() || (c === "Σ" && reading === "ς"))) return false;
  return normalizeUnicode(c) === c && normalizeUnicode(reading) === reading
    && !(c in HOMOGLYPHS) && !(reading in HOMOGLYPHS);
}

function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}
function upperBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= x) lo = mid + 1; else hi = mid; }
  return lo;
}

// One view of the input walked in step with the raw input. The view is built
// from the raw text by deleting characters (invisible ones, surplus blanks) and
// by mapping characters (a look-alike letter, a leet digit). The walk pairs each
// view character with the raw characters it came from. A character that is the
// same in both is paired with itself. A deletion or a mapping is paired only
// when it is one of the named ones and the result is what the view holds, and
// it is recorded. Any other difference ends the walk, and nothing past that
// point is vouched for.
class Walk {
  constructor(raw, low, view, record) {
    this.raw = raw;
    this.low = low;
    this.view = view;
    this.record = record;
    this.held = asciiLower(view);
    const end = view.indexOf(SEP);
    this.limit = end === -1 ? view.length : end;
    this.i = 0;
    this.j = 0;
    this.dead = false;
    this.changed = [];      // view indexes whose character is not the raw character
    this.cuts = [];         // view indexes where raw characters were deleted before it
    this.soft = new Set();  // view indexes with a cut that only collapses a run of plain spaces
    this.hard = new Set();  // view indexes with any other cut
    this.stop = null;       // raw offset from which nothing is vouched for
    this.leftover = null;   // view offsets where an escape the pipeline decodes begins
    this.vcursor = 0;
  }

  stopAt() {
    if (this.stop === null) this.stop = stopOffset(this.raw, this.record);
    return this.stop;
  }

  // The first view offset at or after i where an escape the pipeline decodes
  // begins. A view that still holds one was made by layers of decoding.
  nextLeftover(i) {
    if (this.leftover === null) {
      const view = this.view;
      this.leftover = [];
      ESCAPE_START.lastIndex = 0;
      for (let m; (m = ESCAPE_START.exec(view)) !== null && m.index < this.limit;) {
        if (decodesAt(view, m.index)) this.leftover.push(m.index);
      }
    }
    let k = this.vcursor;
    while (k < this.leftover.length && this.leftover[k] < i) k++;
    this.vcursor = k;
    return k < this.leftover.length ? this.leftover[k] : this.view.length;
  }

  // True when the pipeline decodes more than this reading shows: the reading
  // is not a fixed point of the escape passes, or decoding it together with the
  // raw text after it gives something other than the reading followed by what
  // that text decodes to alone, or its own unfinished escape may be completed
  // past the 64-character window. Ported from the scanner's check.
  //
  // ONE PLACE IS CAUTIOUS ON PURPOSE. The scanner knows every HTML entity name
  // and this port knows a subset, so whenever the text holds anything shaped
  // like an entity the answer is "yes" without decoding it. Everything else
  // (percent escapes, hex escapes, folds, invisible characters, a lone & or a
  // tag character that starts nothing) is decided the way the scanner decides it.
  layered(reading, end) {
    const stop = cpFwd(this.raw, end, 64);
    const window = this.raw.slice(end, stop);
    const probe = reading + window;
    if (isAscii(probe) && !/[&%\\]/.test(probe)) return false;
    const whole = unwrapped(probe);
    const own = unwrapped(reading);
    const rest = unwrapped(window);
    if (whole === null || own === null || rest === null) return true;
    if (own !== reading || whole !== reading + rest) return true;
    // The window ends at 64 characters, and padding the pipeline removes can
    // push the rest of the reading's own escape past that cut. An unfinished
    // start inside the reading, within 48 characters of the cut, counts as
    // finished.
    if (stop < this.raw.length) {
      const cps = Array.from(whole);
      const mine = Array.from(foldOf(reading)).length;
      for (let k = Math.max(0, cps.length - 48); k < Math.min(mine, cps.length); k++) {
        if ("&%\\".includes(cps[k]) && UNFINISHED_ESCAPE.test(cps.slice(k).join(""))) return true;
      }
    }
    return false;
  }

  equalRun(limit) {
    const { low, held } = this;
    const i = this.i, j = this.j;
    const cap = Math.min(limit - i, low.length - j, this.stopAt() - j, this.nextLeftover(i) - i);
    if (cap <= 0 || low[j] !== held[i]) return 0;
    let step = 64;
    let done = 0;
    while (done < cap) {
      const n = Math.min(step, cap - done);
      if (low.startsWith(held.slice(i + done, i + done + n), j + done)) {
        done += n;
        step *= 2;
        continue;
      }
      let k = 0;
      while (low[j + done + k] === held[i + done + k]) k++;
      done += k;
      break;
    }
    // Never stop inside a surrogate pair.
    if (done > 0) {
      const last = low.charCodeAt(j + done - 1);
      if (last >= 0xd800 && last <= 0xdbff) done -= 1;
    }
    return done;
  }

  advance(target) {
    const { raw, view } = this;
    while (this.i < target && !this.dead) {
      const run = this.equalRun(target);
      if (run) { this.i += run; this.j += run; continue; }
      if (this.j >= raw.length) { this.dead = true; break; }
      const i = this.i, j = this.j;
      if (j >= this.stopAt()) { this.dead = true; break; }
      const c = charAt(raw, j);
      if (INVISIBLE_ONE.test(c)) {
        this.cuts.push(i);
        this.hard.add(i);
        this.j = j + c.length;
        continue;
      }
      if (isPySpace(c)) {
        if (view[i] === " ") {
          this.changed.push(i);
          this.i = i + 1;
        } else {
          this.cuts.push(i);
          if (i > 0 && view[i - 1] === " " && this.plainRun(j)) this.soft.add(i);
          else this.hard.add(i);
        }
        this.j = j + c.length;
        continue;
      }
      let matched = false;
      for (const reading of variants(c)) {
        if (!view.startsWith(reading, i)) continue;
        matched = true;
        if (decodesAt(view, i) || this.layered(reading, j + c.length)) {
          this.dead = true;
          break;
        }
        if (!isCaseOf(c, reading)) {
          for (let k = i; k < i + reading.length; k++) this.changed.push(k);
        }
        this.i = i + reading.length;
        this.j = j + c.length;
        break;
      }
      if (!matched) this.dead = true;
    }
  }

  // True if raw[j] is a space that follows another one in a run of blanks that
  // is all plain spaces and at most BLANK_RUN long, so that it is a space the
  // view dropped after keeping the first.
  plainRun(j) {
    const raw = this.raw;
    if (raw[j] !== " ") return false;
    let lo = j;
    while (lo > 0 && isPySpace(raw[lo - 1]) && j - lo <= BLANK_RUN) lo--;
    let hi = j + 1;
    while (hi < raw.length && isPySpace(raw[hi]) && hi - lo <= BLANK_RUN) hi++;
    if (!(lo < j && hi - lo <= BLANK_RUN)) return false;
    for (let k = lo; k < hi; k++) if (raw[k] !== " ") return false;
    return true;
  }

  // True if view[lo:hi] reads as the same characters in the raw input.
  // `spaced` is a function of the index of a space the view kept: when it says
  // yes for a space whose run of plain spaces collapsed to it, the collapse is
  // not counted as an edit. Every other change in the range still is.
  holds(lo, hi, spaced) {
    if (lo < 0 || lo >= hi || hi > this.limit) return false;
    this.advance(hi);
    if (this.i < hi) return false;
    let k = lowerBound(this.changed, lo);
    if (k < this.changed.length && this.changed[k] < hi) return false;
    k = upperBound(this.cuts, lo);
    while (k < this.cuts.length && this.cuts[k] < hi) {
      const at = this.cuts[k];
      if (!spaced || !this.soft.has(at) || this.hard.has(at) || !spaced(at - 1)) return false;
      k++;
    }
    return true;
  }
}

// Whether view[lo:hi] reads as the same characters in the raw input. Each view
// is walked in step with the raw input. A span is vouched for when the walk
// reaches it, no character inside it was mapped, and no raw character was
// deleted inside it. The text after the first view separator holds copies of
// the text (ROT13, reversed) and is never vouched for. A view that is the raw
// text itself needs no check and is not passed here.
export class RawAlign {
  static HIT = 16;   // characters of the match that must read the same in the raw input

  constructor(raw, record) {
    this.raw = raw;
    this.low = null;
    this.walks = new Map();
    this.record = record;
  }

  holds(view, lo, hi, spaced) {
    let walk = this.walks.get(view);
    if (walk === undefined) {
      if (this.low === null) this.low = asciiLower(this.raw);
      walk = new Walk(this.raw, this.low, view, this.record);
      this.walks.set(view, walk);
    }
    return walk.holds(lo, hi, spaced);
  }
}

// End of the view that holds pos: the next view separator, or the end.
export function viewEnd(view, pos) {
  const end = view.indexOf(SEP, pos);
  return end === -1 ? view.length : end;
}

// ── the clause rules ────────────────────────────────────────────────────────

const words = (s) => s.split(/\s+/).filter(Boolean);

// True if the text between a TRUE_NEGATION and the match keeps the match inside
// the negated clause: plain ASCII words (letters, digits, hyphens) joined by
// single spaces, within NEGATION_GAP_WORDS, with no clause word and no leading
// verb of omission. A run of up to BLANK_RUN spaces between two words of the
// gap counts as one space.
function negationGoverns(gap) {
  gap = gap.replace(GAP_SPACES_RX, " ");
  if (!GAP_FULL_RX.test(gap)) return false;
  const ws = words(gap);
  if (ws.length > NEGATION_GAP_WORDS) return false;
  if (ws.length && NEGATION_FLIP_WORDS.has(ws[0])) return false;
  return !ws.some((w) => NEGATION_CLAUSE_WORDS.has(w));
}

// Index of the first closing mark in text[start:stop]. A straight single quote
// between two letters is an apostrophe, not a closing mark.
function findClose(text, close, start, stop) {
  let pos = text.indexOf(close, start);
  while (pos !== -1 && pos + close.length <= stop) {
    if (close !== "'" || !(pos > 0 && isAlnum(cpBefore(text, pos))
        && pos + 1 < text.length && isAlnum(cpAt(text, pos + 1)))) {
      return pos;
    }
    pos = text.indexOf(close, pos + 1);
  }
  return -1;
}

// A cue followed by plain words, an optional colon and ONE opening quote or
// fence governs a hit inside that quote, only while the quote closes after the
// whole hit, in the view the hit is in, and the closing mark is the character
// the raw input holds there. A framing label also takes the opening mark alone.
function quotedGapHolds(gap, text, matchStart, matchEnd, align, label = false) {
  if (matchEnd === undefined || matchEnd === null) return false;
  const m = QUOTED_GAP_RX.exec(gap);
  let opener;
  if (m !== null) {
    const ws = words(m.groups.words || "");
    if (ws.length > NEGATION_QUOTED_GAP_WORDS) return false;
    if (ws.length && NEGATION_FLIP_WORDS.has(ws[0])) return false;
    if (ws.some((w) => NEGATION_CLAUSE_WORDS.has(w))) return false;
    opener = m.groups.open;
  } else if (label && LABEL_OPENER_RX.test(gap)) {
    opener = gap.trim();
  } else {
    return false;
  }
  const close = QUOTE_CLOSERS[opener];
  // The first complete closing mark from the start of the hit is the one that
  // closes this quote: if it starts inside the hit, or straddles its end, the
  // quote closed too early and a later mark does not rescue it.
  const at = findClose(text, close, matchStart, viewEnd(text, matchStart));
  if (at === -1 || at < matchEnd) return false;
  return !align || align.holds(text, at, at + close.length);
}

// For the raw-input check of a negation: says whether a space the view kept,
// where a run of plain spaces collapsed to it, may be read as one space. It may
// when the space sits between two words of the gap, or between two words of the
// match; not inside the cue and not at either edge of the gap.
function spacedInside(text, cueEnd, matchStart) {
  return (at) => {
    if (at < 1 || at + 1 >= text.length) return false;
    const before = cpBefore(text, at), after = cpAt(text, at + 1);
    if (!((isAlnum(before) || before === "-") && (isAlnum(after) || after === "-"))) return false;
    const prev = cpBack(text, at, 1), lastOfMatch = cpBack(text, matchStart, 1);
    return (cueEnd < prev && at + 1 < lastOfMatch) || matchStart <= prev;
  };
}

// True if negation or framing context before a hit should downgrade it from a
// live attack to a warning or an example. True negations defuse the payload
// when they govern the clause it sits in; framing labels downgrade only a
// payload that is quoted or fenced, with the quote closing after the whole hit.
// `align` (a RawAlign) is passed when `text` is a view of the input and not the
// input itself.
export function checkNegation(text, matchStart, align, matchEnd) {
  const windowStart = cpBack(text, matchStart, NEGATION_WINDOW);
  const beforeText = asciiLower(text.slice(windowStart, matchStart));
  let hitEnd = matchStart;
  if (align) hitEnd = Math.min(cpFwd(text, matchStart, RawAlign.HIT), viewEnd(text, matchStart));
  NEGATION_RX.lastIndex = 0;
  for (let m; (m = NEGATION_RX.exec(beforeText)) !== null;) {
    // A window that starts inside a word would read a word fragment as a cue.
    if (m.index === 0 && windowStart > 0 && isAlnum(cpBefore(text, windowStart))) continue;
    const end = m.index + m[0].length;
    const gap = beforeText.slice(end);
    if (!(negationGoverns(gap) || quotedGapHolds(gap, text, matchStart, matchEnd, align))) continue;
    if (!align || align.holds(
      text, cpBack(text, windowStart + m.index, 1), hitEnd,
      spacedInside(text, windowStart + end, matchStart))) {
      return true;
    }
  }
  for (const phrase of FRAMING_LABELS) {
    const pos = beforeText.lastIndexOf(phrase);
    if (pos === -1) continue;
    if (!quotedGapHolds(beforeText.slice(pos + phrase.length), text, matchStart, matchEnd,
      align, true)) continue;
    if (!align || align.holds(text, windowStart + pos, hitEnd)) return true;
  }
  return false;
}

// True if the text between a framing phrase and the match keeps the match
// inside the described clause: plain ASCII words only, no clause word, no
// second person word and at most DEFENSIVE_GAP_WORDS words. An example lead-in
// colon or one short comma parenthetical is read as plain words.
function framingGoverns(gap) {
  let aside = 0;
  if (gap.includes(":")) {
    const m = DEFENSIVE_EXAMPLE_RX.exec(gap);
    if (m === null) return false;
    gap = m.groups.lead + " " + m.groups.rest;
  } else if (gap.includes(",")) {
    const m = DEFENSIVE_PAREN_RX.exec(gap);
    if (m === null) return false;
    aside = words(m.groups.par).length;
    gap = [m.groups.pre, m.groups.par, m.groups.post].filter((p) => p).join(" ")
      + (gap.endsWith(" ") ? " " : "");
  }
  if (!GAP_FULL_RX.test(gap)) return false;
  const ws = words(gap);
  if (ws.length - aside > DEFENSIVE_GAP_WORDS) return false;
  return !ws.some((w) => w.split("-").some((part) => DEFENSIVE_BREAK_WORDS.has(part)));
}

// A framing phrase followed by plain words, an optional colon and ONE opening
// quote or fence governs a match inside that quote, only while the quote closes
// after the whole match, in the view the match is in, and the closing mark is
// the character the raw input holds there.
function framingQuoteHolds(gap, text, matchStart, matchEnd, align) {
  if (matchEnd === undefined || matchEnd === null) return false;
  const m = DEFENSIVE_QUOTED_GAP_RX.exec(gap);
  if (m === null) return false;
  const ws = words(m.groups.words || "");
  if (ws.length > DEFENSIVE_QUOTED_GAP_WORDS) return false;
  if (ws.some((w) => w.split("-").some((part) => DEFENSIVE_BREAK_WORDS.has(part)))) return false;
  const close = QUOTE_CLOSERS[m.groups.open];
  // What the quote holds in front of the match may be any text, but not the
  // mark that closes it: the quote has to still be open where the match starts.
  const quotedFrom = matchStart - (gap.length - m[0].length);
  if (findClose(text, close, quotedFrom, matchStart) !== -1) return false;
  const at = findClose(text, close, matchStart, viewEnd(text, matchStart));
  if (at === -1 || at < matchEnd) return false;
  return !align || align.holds(text, at, at + close.length);
}

// True if a MECHANISM match sits inside a clause that is describing the attack
// rather than performing it ("this scanner detects attempts to ..."). The
// framing must lead the same clause the payload sits in; without that bound one
// "detects" in an intro paragraph would defuse every payload in the document.
export function isDefensivelyFramed(text, matchStart, align, matchEnd) {
  const windowStart = cpBack(text, matchStart, DEFENSIVE_WINDOW);
  // One character left of the window is read as well, so a phrase that begins
  // on the first character of the window is judged against the text in front of
  // it and not against the edge of the window.
  const context = windowStart > 0 ? cpBefore(text, windowStart).length : 0;
  const start = windowStart - context;
  const before = asciiLower(text.slice(start, matchStart));
  let hitEnd = matchStart;
  if (align) hitEnd = Math.min(cpFwd(text, matchStart, RawAlign.HIT), viewEnd(text, matchStart));
  DEFENSIVE_RX.lastIndex = context;
  for (let m; (m = DEFENSIVE_RX.exec(before)) !== null;) {
    // A combining mark in front of the phrase joins it to the word before.
    if (m.index > 0 && /^\p{M}/u.test(cpBefore(before, m.index))) continue;
    const gap = before.slice(m.index + m[0].length);
    if (!(framingGoverns(gap) || framingQuoteHolds(gap, text, matchStart, matchEnd, align))) continue;
    if (!align || align.holds(
      text, m.index === 0 ? start : cpBack(text, start + m.index, 1), hitEnd)) return true;
  }
  return false;
}

// ── the views behind the plain one ──────────────────────────────────────────

// The views behind the plain one, as [start, end, kept] triples inside
// text[:stop]. The normalizer appends ROT13, reversed and l-for-I views of the
// text behind view separators, so a hit that only one of them holds is an
// occurrence in the input that the plain view does not show. `kept` is true for
// a view that was shown to hold every character of the plain view at the same
// offset; a hit in any other view is never taken for a copy.
export function enrichmentSpans(text, plainEnd, stop, foldedLength) {
  const spans = [];
  let pos = plainEnd;
  while (pos + SEP.length < stop) {
    const lo = pos + SEP.length;
    let hi = text.indexOf(SEP, lo);
    hi = hi === -1 || hi + SEP.length > stop ? stop : hi;
    if (lo < hi) spans.push([lo, hi]);
    pos = hi;
  }
  const kept = keptViews(text.slice(0, plainEnd), text.slice(0, stop), spans.length, foldedLength);
  return spans.map(([lo, hi], k) => [lo, hi, kept[k]]);
}

// For each of the `count` views behind the plain one: true when it keeps the
// position of every character of the plain view (ROT13, and the l-for-I variant
// of the plain or the ROT13 view), false for the reversed ones. Each view that
// keeps the offsets is rebuilt here on its own, the way the normalizer builds
// it, and counts only when it is exactly what stands in `whole`.
function keptViews(plain, whole, count, foldedLength) {
  const none = new Array(count).fill(false);
  if ((foldedLength === undefined ? plain.length : foldedLength) > ENRICH_MAX_LEN) {
    // A long input only gets the ROT13 view, which keeps every offset.
    return count === 1 && whole.length === 2 * plain.length + 3 ? [true] : none;
  }
  const pieces = whole.split(SEP);
  if (pieces.length - 1 !== count || pieces[0] !== plain) return none;
  const rot = decodeRot13(plain);
  const base = [plain];
  if (rot !== plain) base.push(rot.toLowerCase());
  const width = 2 * base.length;
  let sections;
  if (count === width - 1) sections = 1;
  else if (count === 2 * width - 1) sections = 2;
  else return none;
  const shape = (piece) => piece.replace(/\bl(?=[a-z])/g, "i");
  const flags = [];
  for (let index = 1; index < sections * width; index++) {
    const section = Math.floor(index / width);
    const within = index % width;
    if (within >= base.length) { flags.push(false); continue; }   // a reversed view
    const want = section === 0 ? base[within] : shape(base[within]);
    flags.push(pieces[index] === want);
  }
  return flags;
}

// True when view[a:b], inside the appended view view[lo:hi], is the copy of the
// same characters at the same place in the plain view `base`, and so is an
// occurrence the plain view has already shown.
export function samePlace(view, a, b, lo, hi, base) {
  const [blo, bhi] = base;
  if (hi - lo !== bhi - blo) return false;
  const src = blo + (a - lo);
  const n = b - a;
  if (src < blo || src + n > bhi) return false;
  // One whole character on each side, not one UTF-16 unit.
  const aFrom = a > lo ? cpBack(view, a, 1) : a, srcFrom = a > lo ? cpBack(view, src, 1) : src;
  const bTo = b < hi ? cpFwd(view, b, 1) : b, srcTo = b < hi ? cpFwd(view, src + n, 1) : src + n;
  return view.slice(aFrom, bTo) === view.slice(srcFrom, srcTo);
}
