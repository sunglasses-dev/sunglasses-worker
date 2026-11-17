// The words of the page for a finding. Port of the pip scanner's sunglasses/shown_text.py; the rows in
// tests/fixtures/shown_text_rows.json are the contract between the two.
//
// The engine matches on a folded copy of the input (lowercase, look-alike letters and leet digits mapped, blanks
// collapsed, hidden characters dropped), so matched_text can read "gls-pi-ooi", start inside a word, or be empty (a
// rule built from lookaheads consumes nothing). shownText(raw, folded) finds the first span of the input that folds to
// `folded`, widens it to whole words, joins its blanks and cuts a long one at a space. It reads the first READ_CAP
// characters of the input. matched_text is never changed; the report gets an added shown_text.
//
// The two runtimes differ on a few characters; the rows in the fixture are the contract.
import { HOMOGLYPHS, INVISIBLE_CHARS, LEET } from "./preprocessor.js";

export const NO_SINGLE_PHRASE = "no single phrase: this rule reads the whole text";
export const READ_CAP = 200000;
export const SHOW_MAX = 120;

const BLANKS = /[ \t\r\n\f\v]+/g;
const HIDDEN = INVISIBLE_CHARS.source;
const INVERSE = new Map();
for (const table of [HOMOGLYPHS, LEET]) {
  for (const [src, dst] of Object.entries(table)) {
    if ([...dst].length !== 1) continue;
    if (!INVERSE.has(dst)) INVERSE.set(dst, []);
    INVERSE.get(dst).push(src);
  }
}
const CLASSES = new Map();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isBlank = (c) => /\s/u.test(c);
const isAlnum = (c) => /[\p{L}\p{N}]/u.test(c);

function charClass(c) {
  let got = CLASSES.get(c);
  if (got === undefined) {
    const alts = new Set([c]);
    const up = c.toUpperCase();
    if (up.length === c.length && [...up].length === 1) alts.add(up);
    for (const a of INVERSE.get(c) || []) alts.add(a);
    got = "(?:" + [...alts].sort().map(esc).join("|") + ")";
    CLASSES.set(c, got);
  }
  return got;
}

let EXPANDED = null;

// Folded words that one input character becomes (an ellipsis becomes three dots, a ligature two letters).
function expanded() {
  if (EXPANDED === null) {
    EXPANDED = new Map();
    for (let cp = 0xa0; cp < 0x10000; cp++) {
      if (cp >= 0xd800 && cp < 0xe000) continue;
      const c = String.fromCharCode(cp);
      const e = c.normalize("NFKC").toLowerCase();
      if (e.length > 1 && e.length <= 4 && !/^\s+$/u.test(e)) {
        if (!EXPANDED.has(e)) EXPANDED.set(e, []);
        EXPANDED.get(e).push(c);
      }
    }
  }
  return EXPANDED;
}

function patternFor(folded) {
  const chars = [...folded];
  const parts = [];
  const table = expanded();
  let lastBlank = true;
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (isBlank(c)) {
      if (!lastBlank) parts.push("(?:\\s|" + HIDDEN + ")+");
      lastBlank = true;
      i += 1;
      continue;
    }
    if (parts.length && !lastBlank) parts.push("(?:" + HIDDEN + ")*");
    let step = 1;
    for (const size of [4, 3, 2]) {
      if (i + size > chars.length) continue;
      const word = chars.slice(i, i + size).join("");
      const raws = table.get(word);
      if (raws) {
        parts.push("(?:" + [...raws].sort().map(esc).join("|") + "|" +
          chars.slice(i, i + size).map(charClass).join("(?:" + HIDDEN + ")*") + ")");
        step = size;
        break;
      }
    }
    if (step === 1) parts.push(charClass(c));
    lastBlank = false;
    i += step;
  }
  while (parts.length && parts[parts.length - 1].startsWith("(?:\\s|")) parts.pop();
  return parts.join("");
}

function cut(text) {
  text = text.replace(BLANKS, " ").trim();
  if (text.length > SHOW_MAX) {
    text = text.slice(0, SHOW_MAX);
    const at = text.lastIndexOf(" ");
    text = (at > 0 ? text.slice(0, at) : text).replace(/\s+$/, "") + " …";
  }
  return text;
}

export function shownText(raw, folded) {
  if (!folded || !folded.trim()) return NO_SINGLE_PHRASE;
  const page = raw ? raw.slice(0, READ_CAP) : "";
  const pattern = patternFor(folded);
  const hit = pattern ? new RegExp(pattern, "u").exec(page) : null;
  if (!hit) return cut(folded);
  let start = hit.index;
  let end = hit.index + hit[0].length;
  while (start > 0 && isAlnum(page[start - 1]) && isAlnum(page[start])) start -= 1;
  while (end < page.length && isAlnum(page[end - 1]) && isAlnum(page[end])) end += 1;
  return cut(page.slice(start, end));
}

// The findings of one scan with shown_text added; the input list and its findings are not changed.
export function withShownText(findings, raw) {
  return findings.map((f) => ({ ...f, shown_text: shownText(raw, f.matched_text || "") }));
}
