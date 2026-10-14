// Sunglasses Worker — engine port of sunglasses/engine.py scan() (v0.4.9).
// Same lanes, same order: keyword index on NORMALIZED text, regexes on RAW text,
// negation window, worst-severity decision.
import { MECHANISMS } from "./mechanisms.js";
import { PATTERNS } from "./patterns.js";
import {
  codePointLength, decodeShadowAscii, normalizeUnicode, normalizeWithLength, replaceHomoglyphs, stripInvisible,
  VIEW_SEP,
} from "./preprocessor.js";
import {
  RawAlign, checkNegation, cpAt, cpBack, cpBefore, cpFwd, enrichmentSpans, isDefensivelyFramed, isPySpace,
  samePlace, viewEnd,
} from "./negation.js";

const SEVERITY_ORDER = { critical: 4, high: 3, medium: 2, low: 1, review: 0 };
const SEVERITY_TO_DECISION = {
  critical: "block",
  high: "block",
  medium: "quarantine",
  low: "allow_redacted",
  review: "allow_redacted",
};

// Locality rule for whole-document co-occurrence predicates — port of
// engine.py _match_windowed (PR #69). Anchored (lookahead-led) predicates are
// evaluated per overlapping window so their (?=.*A)(?=.*B) signals must
// co-occur LOCALLY; spreading matching words across a 30KB README no longer
// fires. Sticky-flag exec at lastIndex=0 on a slice == Python rx.match().
const COOCCUR_WINDOW = 1200;
const COOCCUR_STRIDE = 600;

// Cap on the folded regex view (port of engine.py MAX_SCAN_BYTES, which bounds
// the same view). A request body is at most 100,000 characters, so this only
// ever cuts a view that NFKC expanded more than ten times.
const MAX_FOLDED_VIEW = 1024 * 1024;

// Step 3.5 length gate: port of engine.py CORROBORATE_NORM_MAX (v0.3.3).
const CORROBORATE_NORM_MAX = 2000;

// The window and the stride are counted in code points, as the scanner counts
// them. A text with no surrogate pair is walked by index, as before.
const SURROGATE = /[\ud800-\udfff]/;

function matchWindowed(rx, text) {
  if (!SURROGATE.test(text)) {
    if (text.length <= COOCCUR_WINDOW) {
      rx.lastIndex = 0;
      return rx.exec(text);
    }
    for (let i = 0; i < text.length; i += COOCCUR_STRIDE) {
      rx.lastIndex = 0;
      const m = rx.exec(text.slice(i, i + COOCCUR_WINDOW));
      if (m) return m;
      if (i + COOCCUR_WINDOW >= text.length) break;
    }
    return null;
  }
  const total = codePointLength(text);
  if (total <= COOCCUR_WINDOW) {
    rx.lastIndex = 0;
    return rx.exec(text);
  }
  for (let at = 0, i = 0; at < total; at += COOCCUR_STRIDE, i = cpFwd(text, i, COOCCUR_STRIDE)) {
    rx.lastIndex = 0;
    const m = rx.exec(text.slice(i, cpFwd(text, i, COOCCUR_WINDOW)));
    if (m) return m;
    if (at + COOCCUR_WINDOW >= total) break;
  }
  return null;
}

// The first n code points of a string: the cut never lands inside a pair.
function cpHead(s, n) {
  return s.slice(0, cpFwd(s, 0, n));
}

// Port of engine.py _eval_regex (v0.3.3). "guarded" = caret-led predicate:
// negation guards keep DOCUMENT scope (a defusing context anywhere in the file
// defuses — the fastapi lesson), the positive core must co-occur in ONE window.
// ── ANCHORED MODE (port of engine.py _match_anchored, landed scanner-side in
// #155) ─────────────────────────────────────────────────────────────────────
// A rule declares the rare token its match cannot happen without, and only the
// text around that token is searched. Ported because the Worker was missing it
// outright: GLS-PI-INFO-API, a HIGH prompt_injection rule, was found by Python
// and not here, and both engines' regexes agree that neither of that rule's two
// regexes matches the document. Python reports it through this lane. A port
// that stops at the regexes is a port of the wrong half.
//
// The fold table, the anchor terms, the span and the decision about whether a
// rule may use this mode at all are computed by the ENGINE'S OWN code at
// compile time and handed over in patterns.js. The span needs Python's regex
// parser and cannot be derived here; re-implementing a rule about where a match
// may be would be a second place for it to be wrong.

// engine.py folds through `_prefilter.fold`: translate, THEN lower. Four
// entries, because lowering first splits U+0130 into two codepoints and the
// table is meant to collapse it.
const CASEFOLD = new Map([[0x130, "i"], [0x131, "i"], [0x212a, "k"], [0x17f, "s"]]);

function fold(text) {
  let out = "";
  for (const ch of text) out += CASEFOLD.get(ch.codePointAt(0)) ?? ch;
  return out.toLowerCase();
}

function matchAnchored(entry, text, start = 0) {
  const { anchors, span } = entry;
  const length = text.length;
  const folded = fold(text);
  // A position found in a differently sized string points somewhere else in the
  // document. engine.py searches everything rather than guess; so does this.
  // The span is a number of code points and the windows below are ranges of
  // UTF-16 units, so a document with a surrogate pair is searched whole too.
  if (folded.length !== length || SURROGATE.test(text)) return searchBounded(entry, text, start, length);

  // A document can be MADE of the anchor, and then the merged windows cover it
  // and anchoring saves nothing. Stop as soon as that is known: the threshold is
  // one more than the number of non-overlapping windows of width `span` that fit.
  const budget = Math.floor(length / Math.max(span, 1)) + 1;
  const spots = [];
  for (const term of anchors) {
    let at = folded.indexOf(term);
    while (at !== -1) {
      spots.push(at);
      if (spots.length > budget) return searchBounded(entry, text, start, length);
      at = folded.indexOf(term, at + 1);
    }
  }
  if (spots.length === 0) return null;       // the rule cannot match this document

  // A match containing the anchor at `p` must START in [p - span, p]. Windows
  // are ranges of START positions, merged where they touch.
  spots.sort((a, b) => a - b);
  const windows = [];
  let lo = Math.max(0, spots[0] - span);
  let hi = spots[0];
  for (const at of spots.slice(1)) {
    if (at - span <= hi) hi = at;
    else { windows.push([lo, hi]); lo = Math.max(0, at - span); hi = at; }
  }
  windows.push([lo, hi]);

  for (const [wlo, whi] of windows) {
    // `+ 1`: a word-boundary operator is answered from the character on each
    // side, and the stop is a wall the regex reads as end of string.
    const stop = Math.min(length, whi + span + 1);
    let pos = Math.max(wlo, start);
    while (pos <= whi) {
      const m = searchBounded(entry, text, pos, stop);
      if (m === null || m.index > whi) break;
      // The stop is an invented end of string. Re-run the match from the same
      // position against the WHOLE document, so what comes back is a match the
      // document really contains.
      const confirmed = matchAt(entry, text, m.index);
      if (confirmed !== null) return confirmed;
      pos = m.index + 1;
    }
  }
  return null;
}

// `rx.search(text, pos, endpos)`, which JavaScript has no direct form of. The
// end is imposed by TRUNCATING THE SUBJECT, so the regex engine backtracks
// inside the window and can settle on a shorter alternative that fits.
//
// The previous version searched the whole document, rejected any result that
// ran past the bound and advanced the start by one. That is not the same
// operation: a pattern whose greedy branch overshoots has a shorter branch that
// Python finds and this discarded, and the later full-document confirmation
// cannot recover a candidate that was never produced. The independent review's neutral control
// is the minimal case, an unbounded expression with declared span 10 over a
// 105 character subject: Python returns [0, 105] and this returned no match.
//
// The left context is kept deliberately. Slicing from `pos` as well would let
// `^` match mid-document and would hide the preceding character from `\b` and
// from lookbehind, and Python's `pos` does neither of those things.
//
// `slice(0, stop)` is not a copy in V8 for subjects of any size worth bounding;
// it produces a sliced string over the same backing store.
function searchBounded(entry, text, pos, stop) {
  const rx = entry.rxGlobal;
  const subject = stop >= text.length ? text : text.slice(0, stop);
  rx.lastIndex = pos;
  const m = rx.exec(subject);
  return m !== null && m.index < stop ? m : null;
}

function matchAt(entry, text, at) {
  const rx = entry.rxSticky;
  rx.lastIndex = at;
  return rx.exec(text);
}

// THE LITERAL PREFILTER, whose derivation lives in the compiler because it needs
// Python's regex parser. Each entry arrives with a CNF requirement: an AND of
// clauses, each an OR of folded ASCII literals at least four characters long. A
// document missing every literal of any one clause cannot match that regex, so
// the regex does not run.
//
// The independent review measured the cost of not having it. The exact #157 document, 27,000
// characters of one long word, completes in Python and took 100 seconds here,
// because every expensive pattern was run against every one of those
// characters. This is the "regex literal prefilter" the review records as
// absent, ported as a skip test rather than as a second parser.
//
// SOUNDNESS COMES FROM THE DERIVATION, not from this function. A clause is
// implied by the match, so skipping when it is absent cannot lose a finding.
// An entry with no requirement is always run.
function canSkip(entry, folded, pages) {
  const requires = entry.requires;
  if (!requires || requires.length === 0) return false;
  for (const clause of requires) {
    let present = false;
    for (const literal of clause.lits) {
      if (folded.includes(literal)) { present = true; break; }
    }
    // A CLASS BRANCH REQUIRES A CHARACTER, not a literal, and this is the half
    // that answers #157: a bare class under `+` carries no literal, so a clause
    // holding one could never be skipped and the whole regex ran on every
    // document. Pages OVERLAP is deliberately conservative, it means a
    // character MIGHT be present, which is the only safe direction for a skip.
    if (!present && clause.pages.length) {
      for (const page of clause.pages) {
        if (pages.has(page)) { present = true; break; }
      }
    }
    if (!present) return true;
  }
  return false;
}

const PAGE_SHIFT = 8;

function pagesOf(text) {
  const pages = new Set();
  for (const ch of text) pages.add(ch.codePointAt(0) >> PAGE_SHIFT);
  return pages;
}

// ── LEAD-IN MODE (port of engine.py _match_leadin, 0.6.8 / #340) ────────────
// Six shipped regexes open with a lead-in whose whitespace takes newlines. A
// search over a long run of blank lines retried from every newline in the run
// and each retry read the rest of it: a 100 KB body cost seconds of CPU, and V8
// has no regex timeout. The rule keeps its source (the match START is read by
// the negation and framing checks); a TWIN with a lead-in that cannot cross a
// newline finds where to start, and the start the source would have used is
// recovered from the run around the candidate.
//
// Sound only for the sources the scanner lists (the compiler asks the scanner,
// the Worker does not remake that decision): the lead-in opens each of them and
// what follows it starts with a character that is neither whitespace nor a comma.
const LEADIN_PUNCT = new Set([".", "!", "?", ";", ":", '"', "'", "[", "{", "("]);

export function matchLeadin(entry, text, lower = 0) {
  let pos = lower;
  for (;;) {
    entry.rxTwin.lastIndex = pos;
    const first = entry.rxTwin.exec(text);
    if (first === null) return null;
    const at = first.index;
    let start;
    if (text.charAt(at) === "\n") {
      let run = at;
      while (run > 0 && isPySpace(text.charAt(run - 1))) run--;
      // `lower` is a lower bound on where the match begins: a boundary character
      // before it is not used, and the first newline of the run at or after it
      // stands in, which is where the rule would begin if asked to start there.
      if (run > 0 && run - 1 >= lower && LEADIN_PUNCT.has(text.charAt(run - 1))) start = run - 1;
      else start = text.indexOf("\n", Math.max(run, lower));
    } else {
      start = at;
    }
    entry.rxSticky.lastIndex = start;
    const m = entry.rxSticky.exec(text);
    if (m !== null) return m;
    // One code point on, so a surrogate pair is never split.
    pos = at + (text.codePointAt(at) > 0xffff ? 2 : 1);
  }
}

// `start` asks for the first match that begins at or after that offset, in the
// modes whose offsets are offsets into `text` (anchored, lead-in, plain). The
// windowed modes report offsets inside a window, never downgrade on negation,
// and are not asked (port of engine.py _eval_regex).
function evalRegex(entry, text, folded, pages, start = 0) {
  if (folded !== undefined && canSkip(entry, folded, pages)) return null;
  if (start && (entry.mode === "guarded" || entry.mode === "windowed")) return null;
  if (entry.mode === "anchored") return matchAnchored(entry, text, start);
  if (entry.mode === "leadin") return matchLeadin(entry, text, start);
  if (entry.mode === "guarded") {
    for (const g of entry.guards) {
      g.lastIndex = 0;
      if (g.exec(text)) return null;
    }
    return matchWindowed(entry.rx, text);
  }
  if (entry.mode === "windowed") {
    return matchWindowed(entry.rx, text);
  }
  if (start) {
    if (entry.rxFrom === undefined) {
      const flags = entry.rx.flags.includes("g") ? entry.rx.flags : entry.rx.flags + "g";
      entry.rxFrom = new RegExp(entry.rx.source, flags);
    }
    entry.rxFrom.lastIndex = start;
    return entry.rxFrom.exec(text);
  }
  entry.rx.lastIndex = 0;
  return entry.rx.exec(text);
}

// ── CHANNEL VOCABULARY (port of engine.py, v0.4.3) ──────────────────────────
// The channels the public API documents. Kept even if no loaded pattern
// currently declares one, so the documented contract always validates.
// Pattern-declared channels are unioned in during the index build below.
const DOCUMENTED_CHANNELS = [
  "message", "file", "api_response", "web_content", "log_memory",
  "tool_output", "agent_input", "code", "prompt",
];

// Sparse or synonym channels union with their canonical provenance. The
// 9-channel matrix showed a valid-but-sparse channel could silently ALLOW an
// obvious injection: "prompt" had 3 patterns, "email" 1, "code" 28 — so
// scanning with the most natural channel name gave clean false reassurance. A
// scan on an alias channel matches patterns declaring EITHER name; channel-
// specific patterns still fire. Canonical channels are untouched, so the
// FP-hardened file/message corpora govern the inherited scope.
export const CHANNEL_ALIASES = {
  prompt: "message",        // a prompt is a message-borne instruction
  conversation: "message",
  email: "message",         // an email body is a message
  log: "log_memory",
  image_alt_text: "web_content",
  code: "file",             // source code is a file; the clean-code FP corpus
                            // was built on the file channel
};

// ── Index build (once per isolate) ──────────────────────────────────────────
const keywordToPatterns = new Map();
export const DEAD_REGEX_IDS = [];  // regexes that failed to construct in THIS runtime
const regexPatterns = [];
export const LEADIN_ENTRIES = [];  // [{ id, entry }] for the lead-in mode; the parity test reads them
const declaredChannels = new Set();
let keywordCount = 0;

// Carriers first, then mechanisms — mirrors engine.py's list order so the
// findings arrays come out identical (parity harness compares them element-wise).
for (const p of [...PATTERNS, ...MECHANISMS]) {
  for (const ch of p.channel || []) declaredChannels.add(ch);
  for (const kw of p.keywords || []) {
    const k = kw.toLowerCase();
    if (!keywordToPatterns.has(k)) keywordToPatterns.set(k, []);
    keywordToPatterns.get(k).push(p);
    keywordCount++;
  }
  if (p.regex && p.regex.length) {
    const compiled = [];
    for (const r of p.regex) {
      try {
        // Predicates (windowed/guarded cores + doc-wide guards) run at position
        // 0 via sticky flag (mirrors Python .match) — the ReDoS guard from
        // engine.py. Plain regexes keep ordinary exec (Python .search).
        const sticky = r.mode !== "plain" && r.mode !== "anchored" && r.mode !== "leadin";
        const entry = {
          mode: r.mode,
          rx: new RegExp(r.source, r.flags + (sticky ? "y" : "")),
          guards: (r.guards || []).map((g) => new RegExp(g.source, g.flags + "y")),
          // CARRIED THROUGH. The compiler derives this and the index dropped it,
          // so every entry arrived with no requirement and the prefilter skipped
          // nothing at all. Silent, because a prefilter that never fires is
          // indistinguishable from one that has nothing to skip.
          requires: r.requires,
        };
        if (r.mode === "anchored") {
          // TWO compiled forms, because the Python lane makes two different
          // calls: a bounded `search` and, on a candidate, an anchored `match`
          // against the whole document. `g` gives the first a movable start,
          // `y` gives the second Python's `.match(text, pos)` exactly.
          entry.rxGlobal = new RegExp(r.source, r.flags + "g");
          entry.rxSticky = new RegExp(r.source, r.flags + "y");
          entry.anchors = r.anchors || [];
          entry.span = Math.max(r.span || 1, 1);
        }
        if (r.mode === "leadin") {
          // The rule's own regex, sticky, for the recovered start (Python's
          // `.match(text, pos)`); the twin, global, to find a candidate.
          entry.rxSticky = new RegExp(r.source, r.flags + "y");
          entry.rxTwin = new RegExp(r.twin, r.twin_flags + "g");
          LEADIN_ENTRIES.push({ id: p.id, entry });
        }
        compiled.push(entry);
      } catch {
        // Validated at compile time — but only for the Node that ran the
        // compiler. A runtime with an older V8 (e.g. `(?i:` modifier groups
        // need Node 23+) can still fail here, silently killing the pattern
        // (CI caught GLS-SC-002/003 dead on Node 22, 2026-08-28). Record it
        // so CI can assert the count is zero in ITS runtime; the worker
        // itself stays fail-open per pattern.
        DEAD_REGEX_IDS.push(p.id);
      }
    }
    if (compiled.length) regexPatterns.push({ pattern: p, compiled });
  }
}

// CORROBORATE, DON'T STAMP (v0.3.3) — ids of patterns with at least one usable
// compiled regex. For these, a bare keyword substring match is a PRE-SCREEN,
// never a verdict: the pattern's own regex must confirm before a finding is
// stamped. Port of engine.py _regex_bearing_ids (the claude-seo lesson:
// "authoritative" ⊂ "Authoritativeness" stamped 55 keyword-only BLOCKs).
const regexBearingIds = new Set(regexPatterns.map(({ pattern }) => pattern.id));
const compiledById = new Map(regexPatterns.map(({ pattern, compiled }) => [pattern.id, compiled]));

// Fail-closed channel vocabulary (port of engine.py, v0.4.3). An unknown
// channel used to filter out EVERY pattern and return a clean ALLOW — silent
// false safety. Valid = the documented API channels plus every channel any
// loaded pattern declares, so a typo can never scan against nothing.
export const VALID_CHANNELS = new Set([...DOCUMENTED_CHANNELS, ...declaredChannels]);

// Python str.isalnum() is unicode-aware; \p{L}\p{N} is the closest JS
// equivalent (letters + every numeric category). Wider than ASCII \w, which is
// why the \w/\b limitation note does not apply to this check.
const ALNUM = /[\p{L}\p{N}]/u;

// Port of engine.py _word_bounded (v0.4.3), the "ignore previously cached
// tokens" false block: "ignore previous" substring-matched inside "previously".
// English false positives are suffix morphology (-ly, -es, -ing), so only the
// TRAILING edge is enforced. The LEADING edge stays permissive ON PURPOSE:
// layered base64 decoding leaves residue glued to the front of a payload
// ("aignore all previous instructions"), and a leading check would hand
// attackers a one-character evasion (benchmark case OB-B64x2-01).
function wordBounded(text, start, keyword) {
  const end = start + keyword.length;
  if (end < text.length && ALNUM.test(cpBefore(keyword, keyword.length)) && ALNUM.test(cpAt(text, end))) return false;
  return true;
}

// Python str.strip() also strips the C0 separators (\x1c-\x1f, incl. VIEW_SEP)
// and \x85, which JS String.prototype.trim() does not. Mirrored so an excerpt
// that ends flush against a view boundary reads the same in both engines.
const PY_STRIP = /^[\s\x1c-\x1f\x85]+|[\s\x1c-\x1f\x85]+$/gu;

// Port of engine.py _excerpt (v0.4.3): context window around a match, clamped
// to the enrichment view that matched — windows used to bleed across the
// plain/ROT13/reversed view boundary and splice decoded gibberish into
// matched_text.
function excerpt(normalized, kwStart, kwEnd) {
  let start = cpBack(normalized, kwStart, 10);
  let end = cpFwd(normalized, kwEnd, 20);
  // rfind(VIEW_SEP, start, kwStart) — guard kwStart===0, where JS lastIndexOf
  // with a negative fromIndex would still probe index 0 (Python's range is empty).
  if (kwStart > 0) {
    const left = normalized.lastIndexOf(VIEW_SEP, kwStart - 1);
    if (left !== -1 && left >= start) start = left + 1;
  }
  const right = normalized.indexOf(VIEW_SEP, kwEnd);   // find(VIEW_SEP, kwEnd, end)
  if (right !== -1 && right < end) end = right;
  return normalized.slice(start, end).replace(PY_STRIP, "");
}

function makeFinding(pattern, matchedText, negated, defensive = false) {
  const f = {
    id: pattern.id,
    name: pattern.name,
    category: pattern.category,
    severity: pattern.severity,
    description: pattern.description,
    matched_text: matchedText,
  };
  if (negated) {
    f.original_severity = pattern.severity;
    f.severity = "review";
    f.negation_context = true;
  } else if (defensive) {
    f.original_severity = pattern.severity;
    f.severity = "review";
    f.defensive_context = true;
  }
  return f;
}

// ── LATER HITS (port of engine.py _later_live and its helpers, 0.6.8) ───────
// A rule reports its first hit. When that hit sits under a negation or inside a
// quote or a describing clause, later hits of the same rule are judged on their
// own, so a quoted first copy cannot hide a bare second one. At most this many
// later hits are read per rule, counted over all its alternatives, all its
// subjects and the corroboration pass together; past it the rule keeps its
// severity, which costs only a text that repeats one warning dozens of times and
// keeps the work bounded on a text built to waste it.
const LATER_HITS = 32;
const SEP = " " + VIEW_SEP + " ";
const FIRST = "\0first:";
const SKIP = "\0skip:";

function matchEnd(m) {
  return m.index + m[0].length;
}

// Where the search for the next hit begins: one character after the start of
// this one. A lead-in rule that began at a boundary character skips the blanks
// behind it too, because a start inside them reads the same words again.
function resumeAfter(mode, view, m) {
  let pos = cpFwd(view, m.index, 1);
  if (mode === "leadin") {
    const c = view.charAt(m.index);
    if (c === "\n" || LEADIN_PUNCT.has(c)) {
      while (pos < view.length && isPySpace(view.charAt(pos))) pos++;
    }
  }
  return pos;
}

// True when view[a:b] holds only blanks and boundary characters.
function leadInOnly(view, a, b) {
  for (let i = a; i < b; i++) {
    const c = view.charAt(i);
    if (!isPySpace(c) && !LEADIN_PUNCT.has(c)) return false;
  }
  return true;
}

// The regex form of samePlace: the same characters stand at the same place in the
// plain view and the same regex matches there with the same extent, so that hit
// was read there already.
function copyOfJudgedHit(entry, view, m, lo, hi, base) {
  const end = matchEnd(m);
  if (!samePlace(view, m.index, end, lo, hi, base)) return false;
  const src = base[0] + (m.index - lo);
  const n = end - m.index;
  const there = evalRegex(entry, view, undefined, undefined, src);
  return there !== null && there.index === src && matchEnd(there) === src + n;
}

// True when this hit sits under a negation or, for a mechanism rule (`framed`),
// inside a clause that describes the attack. `negation` is false for a rule with
// negation_immune, where only the framing can cover a hit.
function hitCovered(view, start, align, end, framed, negation) {
  return (negation && checkNegation(view, start, align, end))
    || (framed && isDefensivelyFramed(view, start, align, end));
}

const bump = (spent, key) => {
  const n = (spent.get(key) ?? 0) + 1;
  spent.set(key, n);
  return n;
};

// True when a later hit of the same regex is NOT covered by a negation or, for a
// mechanism rule (`framed`), by a clause that describes the attack. `limit` ends
// the part of the text that is read: the normalized text repeats itself after a
// view separator. `spans` are the views behind the plain one; a hit in one of
// them is read, unless the view keeps the offsets of the plain view and the hit
// is the copy of a hit the plain view has already shown. `tail` is the input
// with its invisible shadow characters read as ASCII, behind the separators.
function laterLive(entry, subject, first, align, limit, tail, spans, spent, pid, framed, negation) {
  const mode = entry.mode;
  if (mode === "guarded" || mode === "windowed") return false;
  // The first hit of the rule is the one that is judged; this hit is a later hit
  // of the rule when another alternative or another subject had one before it.
  if (spent.has(FIRST + pid)) {
    if (bump(spent, pid) > LATER_HITS) return true;
  } else {
    spent.set(FIRST + pid, true);
  }
  // Resume one character after the start of the previous hit, not at its end, so
  // a hit that begins inside a covered one is judged on its own.
  const regions = [[subject, resumeAfter(mode, subject, first), limit, null, null]];
  if (spans) {
    const plain = [0, viewEnd(subject, 0)];
    for (const [lo, hi, kept] of spans) {
      if (limit !== null && lo > limit) regions.push([subject, lo, hi, lo, kept ? plain : []]);
    }
  }
  if (tail !== null) {
    regions.push([tail.text, 0, tail.plain, null, null]);
    const plain = [0, tail.plain];
    for (const [lo, hi, kept] of tail.spans) regions.push([tail.text, lo, hi, lo, kept ? plain : []]);
  }
  // A regex with a variable lead-in reaches the same words from several starts in
  // a row (the blanks and boundary marks in front of them). A start that ends
  // where the previous one did, with only blanks and boundary marks between them,
  // is the same occurrence and is stepped over; at most LATER_HITS of these are
  // passed over per rule, so the work stays bounded, and every other hit is a hit
  // read and counted.
  for (let index = 0; index < regions.length; index++) {
    const [view, from, stop, copyLo, base] = regions[index];
    let pos = from;
    let prev = index === 0 ? first : null;
    for (;;) {
      const m = evalRegex(entry, view, undefined, undefined, pos);
      if (m === null || (stop !== null && m.index >= stop)) break;
      pos = resumeAfter(mode, view, m);
      if (prev !== null && matchEnd(m) === matchEnd(prev)
          && (spent.get(SKIP + pid) ?? 0) < LATER_HITS
          && leadInOnly(view, prev.index, m.index)) {
        bump(spent, SKIP + pid);
        prev = m;
        continue;   // the same words; only how much of the lead-in is counted differs
      }
      prev = m;
      if (base !== null && base.length && copyOfJudgedHit(entry, view, m, copyLo, stop, base)) continue;
      if (bump(spent, pid) > LATER_HITS) return true;   // the cap is spent and a further hit remains
      if (base !== null || !hitCovered(view, m.index, align, matchEnd(m), framed, negation)) return true;
    }
  }
  return false;
}

// How this hit and every later hit of its regex are covered: "negation" when the
// first sits under a negation or inside a quote, "framing" when it sits in a
// clause that describes the attack (`framed`, mechanism rules only), null when it
// is not covered or any later hit is live. A later hit is covered by the same two
// ways, so a framed or negated first hit never hides a live one. A rule with
// negation_immune is never covered by a negation.
function regexCovered(pattern, entry, subject, match, align, limit, tail, spans, spent, framed) {
  const negation = !pattern.negation_immune;
  let how;
  if (negation && checkNegation(subject, match.index, align, matchEnd(match))) how = "negation";
  else if (framed && isDefensivelyFramed(subject, match.index, align, matchEnd(match))) how = "framing";
  else return null;
  if (laterLive(entry, subject, match, align, limit, tail, spans, spent, pattern.id, framed, negation)) {
    return null;
  }
  return how;
}

// The keyword path: true when another hit of `keyword` in a region that is read,
// other than the hit `skip` that was already judged, is not under a negation, or
// when the rule has used up its cap of later hits. `regions` are [view, offset of
// the view in the normalized text, start and end in the view, the plain view it is
// a copy of or null].
function laterKeywordLive(regions, keyword, skip, align, spent, pid) {
  for (const [view, shift, lo, hi, base] of regions) {
    let at = view.indexOf(keyword, lo);
    while (at !== -1 && at + keyword.length <= hi) {
      const isFirst = skip[0] === keyword && skip[1] === at + shift;
      if (!isFirst && wordBounded(view, at, keyword)
          && !(base !== null && base.length && samePlace(view, at, at + keyword.length, lo, hi, base))) {
        if (bump(spent, pid) > LATER_HITS || base !== null
            || !checkNegation(view, at, align, at + keyword.length)) {
          return true;
        }
      }
      at = view.indexOf(keyword, at + 1);
    }
  }
  return false;
}

// A finding that a negation or a describing clause downgraded gets its plain
// severity back.
function restore(finding) {
  finding.severity = finding.original_severity;
  delete finding.original_severity;
  delete finding.negation_context;
  delete finding.defensive_context;
}

function held(pattern, matchedText, cover) {
  return makeFinding(pattern, matchedText, cover === "negation", cover === "framing");
}

export function scan(text, channel = "message") {
  // Unknown channels fail CLOSED (throw) instead of silently scanning against
  // nothing and returning a clean allow — mirrors engine.py's ValueError. The
  // caller (index.js) turns this into a 400; it must never become an "allow".
  if (!VALID_CHANNELS.has(channel)) {
    throw new Error(
      `Unknown channel '${channel}'. Valid channels: ${[...VALID_CHANNELS].sort().join(", ")}`,
    );
  }
  const aliasChannel = CHANNEL_ALIASES[channel] ?? channel;
  // Port of engine.py `match_channels.isdisjoint(pattern["channel"])`.
  const channelHit = (p) => {
    const ch = p.channel || [];
    return ch.includes(channel) || ch.includes(aliasChannel);
  };

  // NOTE: Cloudflare freezes Date.now() during synchronous execution (timing-attack
  // defense), so a pure-CPU scan measures 0ms in production. We return null rather
  // than a fake number; the UI hides it. Real timing lives in CF's own metrics.
  const start = Date.now();
  // `record` collects each base64 blob the pipeline replaced; the raw-input check
  // of a negation reads it.
  const record = [];
  const [normalized, foldedLength] = normalizeWithLength(text, record);
  const align = new RawAlign(text, record);
  const plainEnd = viewEnd(normalized, 0);
  // The raw text read with one more invisible encoding decoded, for rules that
  // match raw text. null for ordinary text, which costs nothing. engine.py.
  const shadow = decodeShadowAscii(text);
  // The normalizer appends the shadow reading as a view of its own, behind the
  // separators, and a hit there is a real occurrence in the input, not a copy: it
  // is read as a later hit like one in the plain view, against the raw input.
  let tail = null;
  let tailStart = normalized.length;
  if (shadow !== null) {
    const [tailText, tailFolded] = normalizeWithLength(shadow);
    if (normalized.endsWith(tailText)) {
      tailStart = normalized.length - tailText.length;
      const tailPlain = viewEnd(tailText, 0);
      tail = {
        text: tailText,
        plain: tailPlain,
        spans: enrichmentSpans(tailText, tailPlain, tailText.length, tailFolded),
      };
    }
  }
  // Where the views behind the plain one are: ROT13, reversed and l-for-I copies.
  // A hit that only one of them holds is another occurrence in the input, and is
  // read like a later hit in the plain view. Only a view that keeps every offset
  // of the plain one (ROT13, l-for-I) can hold the copy of a hit the plain view
  // already showed; a reversed view is never a copy.
  const mainStop = tail !== null && normalized.startsWith(SEP, tailStart - SEP.length)
    ? tailStart - SEP.length : tailStart;
  const spans = enrichmentSpans(normalized, plainEnd, mainStop, foldedLength);
  const plainBase = [0, plainEnd];
  const regions = [[normalized, 0, 0, plainEnd, null]];
  for (const [lo, hi, kept] of spans) regions.push([normalized, 0, lo, hi, kept ? plainBase : []]);
  if (tail !== null) {
    regions.push([tail.text, tailStart, 0, tail.plain, null]);
    for (const [lo, hi, kept] of tail.spans) {
      regions.push([tail.text, tailStart, lo, hi, kept ? [0, tail.plain] : []]);
    }
  }

  // The raw text with three of the preprocessor's character folds applied
  // (port of engine.py step 3, scanner #342): invisible characters deleted,
  // NFKC, homoglyphs mapped to their ASCII look-alike. The keyword lane has
  // always read a view with these folds and the regex lane did not, so one
  // zero-width space per word, a soft hyphen or a look-alike letter blinded
  // every rule that lives on its regex. ASCII text is never folded and never
  // pays a second pass, and neither does text that folds to itself. NFKC can
  // expand a code point, so the folded view is cut at MAX_FOLDED_VIEW; when the
  // fold went past the cut, the two folds that cannot grow (delete, map) are
  // also kept as a subject of their own, in full, so padding cannot push a
  // payload hidden with invisible characters past the cut.
  let folded = null;
  let compact = null;
  if (/[^\x00-\x7f]/.test(text)) {
    const stripped = stripInvisible(text);
    folded = replaceHomoglyphs(normalizeUnicode(stripped));
    if (folded.length > MAX_FOLDED_VIEW && codePointLength(folded) > MAX_FOLDED_VIEW) {
      compact = replaceHomoglyphs(stripped);
      if (compact === text) compact = null;
      folded = folded.slice(0, cpFwd(folded, 0, MAX_FOLDED_VIEW));
    }
    if (folded === text) folded = null;
  }
  const findings = [];
  const seen = new Set();
  // Keyword findings that a negation downgraded, until a later hit of the same
  // rule that no negation covers puts the severity back.
  const downgraded = new Map();
  const firstHit = new Map();
  // Later hits read per rule, against the same cap on both lanes.
  const laterSpent = new Map();
  // Regex findings that a negation downgraded; step 3.5 may still restore them.
  const heldRegex = new Map();

  // Lane 1: keywords on normalized text. v0.3.3: a keyword hit on a
  // regex-bearing pattern is a PRE-SCREEN into `candidates`, not a verdict —
  // the pattern's own regex must confirm (lane 2 on raw, lane 2.5 on
  // normalized). Keyword-only patterns keep keyword-verdict behavior.
  const candidates = new Map();
  for (const [keyword, patterns] of keywordToPatterns) {
    // v0.4.3 word boundary: take the first occurrence whose TRAILING edge is a
    // real word end. Python's Aho-Corasick path (the reference the parity gates
    // run against) yields every occurrence and skips the unbounded ones, so a
    // keyword buried in a longer word earlier in the text must not shadow a
    // genuine hit later — plain indexOf on occurrence #1 would do exactly that.
    let idx = -1;
    for (let at = normalized.indexOf(keyword); at !== -1; at = normalized.indexOf(keyword, at + 1)) {
      if (wordBounded(normalized, at, keyword)) { idx = at; break; }
    }
    if (idx === -1) continue;
    for (const pattern of patterns) {
      if (!channelHit(pattern)) continue;
      const pid = pattern.id;
      if (seen.has(pid) || candidates.has(pid)) {
        const heldFinding = downgraded.get(pid);
        if (heldFinding !== undefined
            && laterKeywordLive(regions, keyword, firstHit.get(pid), align, laterSpent, pid)) {
          // Any later hit of the rule that no negation covers puts the severity back.
          restore(heldFinding);
          downgraded.delete(pid);
        }
        continue;
      }
      if (regexBearingIds.has(pid)) {
        candidates.set(pid, pattern);
        continue;
      }
      seen.add(pid);
      const matched = excerpt(normalized, idx, idx + keyword.length);
      const negated = !pattern.negation_immune
        && checkNegation(normalized, idx, align, idx + keyword.length);
      const finding = makeFinding(pattern, matched, negated);
      if (negated) {
        downgraded.set(pid, finding);
        firstHit.set(pid, [keyword, idx]);
        if (laterKeywordLive(regions, keyword, [keyword, idx], align, laterSpent, pid)) {
          restore(finding);
          downgraded.delete(pid);
        }
      }
      findings.push(finding);
    }
  }

  // Lane 2: regexes on RAW text, then on the other views for a pattern that asks
  // for them (same as engine.py step 3). Raw stays FIRST and decides. engine.py's
  // own note: replacing raw with normalized lost four detections whose filler was
  // U+2028/U+2029, where the raw text matched and the folded text did not, so a
  // flag meant to add reach removed some. The other views are a second look, never
  // a substitute.
  //
  // A hit that a negation or a describing clause covers does not settle the rule:
  // the other subjects and the other regexes of the rule are read too, and any hit
  // in them that nothing covers gives the rule its plain severity. The covered
  // finding is kept only when every hit is covered.
  const foldCache = new Map();
  for (const { pattern, compiled } of regexPatterns) {
    if (!channelHit(pattern)) continue;
    if (seen.has(pattern.id)) continue;
    const framed = pattern.id.startsWith("GLS-MECH-");
    // [view, kind]. The kind says which view it is, because the raw text needs no
    // check against itself and the normalized one carries the other views.
    const subjects = [[text, "raw"]];
    if (shadow !== null) subjects.push([shadow, "shadow"]);
    if (folded !== null) subjects.push([folded, "folded"]);
    if (compact !== null) subjects.push([compact, "compact"]);
    if (pattern.match_on === "normalized") subjects.push([normalized, "normalized"]);
    let heldHit = null;
    let decided = false;
    for (const [subject, kind] of subjects) {
      // Folded ONCE per subject and reused for every entry of this pattern, the
      // way Python folds the document once for the whole index. Folding per
      // entry would hand the cost straight back.
      let view = foldCache.get(subject);
      if (view === undefined) {
        const foldedSubject = fold(subject);
        view = { folded: foldedSubject, pages: pagesOf(foldedSubject) };
        foldCache.set(subject, view);
      }
      const isNormalized = kind === "normalized";
      for (const entry of compiled) {
        const m = evalRegex(entry, subject, view.folded, view.pages);
        if (!m) continue;
        // NOTE: for windowed matches m.index is slice-relative; Python has the
        // IDENTICAL behavior (match.start() is window-relative in _match_windowed
        // results). Do NOT "fix" by adding the window offset; parity depends on
        // mirroring engine.py exactly.
        const cover = regexCovered(
          pattern, entry, subject, m, kind === "raw" ? null : align,
          isNormalized ? viewEnd(normalized, m.index) : null,
          isNormalized ? tail : null, isNormalized ? spans : null, laterSpent, framed);
        if (cover !== null) {
          if (heldHit === null) heldHit = held(pattern, cpHead(m[0], 50), cover);
          continue;
        }
        findings.push(makeFinding(pattern, cpHead(m[0], 50), false));
        heldHit = null;
        decided = true;
        break;      // raw decided first; later subjects are only read while covered
      }
      if (decided) break;
    }
    if (decided) {
      seen.add(pattern.id);
    } else if (heldHit !== null) {
      seen.add(pattern.id);
      heldRegex.set(pattern.id, heldHit);
      findings.push(heldHit);
    }
  }

  // Lane 2.5 — corroboration pass (port of engine.py step 3.5, v0.3.3): a
  // candidate still unconfirmed after the raw-text lane gets one regex try on
  // the NORMALIZED view — where homoglyph/ROT13/leet folds live — so encoded
  // evasions still corroborate. Short inputs only (same reasoning as the
  // preprocessor's enrichment gate: encoding evasions live in short crafted
  // payloads; a long document's compacted normalized view re-creates the
  // spread-text FPs the window exists to prevent). A candidate whose regex
  // fires on neither view is a keyword-only echo and is dropped. A finding that
  // step 3 downgraded is read again here: the normalized view holds hits the raw
  // text does not, and one that nothing covers gives the rule its plain severity.
  if (foldedLength <= CORROBORATE_NORM_MAX) {
    for (const [pid, pattern] of candidates) {
      const heldFinding = heldRegex.get(pid);
      if (seen.has(pid) && heldFinding === undefined) continue;
      const framed = pid.startsWith("GLS-MECH-");
      let pending = null;
      for (const entry of compiledById.get(pid) || []) {
        const m = evalRegex(entry, normalized);
        if (!m) continue;
        const cover = regexCovered(
          pattern, entry, normalized, m, align, viewEnd(normalized, m.index), tail, spans,
          laterSpent, framed);
        if (cover !== null) {
          if (heldFinding === undefined && pending === null) {
            pending = held(pattern, cpHead(m[0], 50), cover);
          }
          continue;
        }
        if (heldFinding !== undefined) {
          restore(heldFinding);
          heldFinding.matched_text = cpHead(m[0], 50);
        } else {
          seen.add(pid);
          findings.push(makeFinding(pattern, cpHead(m[0], 50), false));
          pending = null;
        }
        break;
      }
      if (pending !== null) {
        seen.add(pid);
        findings.push(pending);
      }
    }
  }

  // Lane 3 — mechanism fallback suppression (port of engine.py step 3b).
  // A mechanism earns its keep by catching what the carrier list structurally
  // cannot. When a carrier of the same category already fired at >= severity,
  // the mechanism is reporting the same attack twice — drop it. Not an evasion
  // route: suppression requires a carrier to have already matched, i.e. the
  // input is already caught.
  let kept = findings;
  if (findings.some((f) => f.id.startsWith("GLS-MECH-"))) {
    const carrierMax = new Map();
    for (const f of findings) {
      if (f.id.startsWith("GLS-MECH-")) continue;
      const rank = SEVERITY_ORDER[f.severity] ?? 0;
      if (rank > (carrierMax.get(f.category) ?? -1)) carrierMax.set(f.category, rank);
    }
    kept = findings.filter(
      (f) =>
        !f.id.startsWith("GLS-MECH-") ||
        (carrierMax.get(f.category) ?? -1) < (SEVERITY_ORDER[f.severity] ?? 0)
    );
  }

  // Decision = worst finding severity.
  let decision = "allow";
  if (kept.length) {
    let worst = kept[0];
    for (const f of kept) {
      if ((SEVERITY_ORDER[f.severity] ?? 0) > (SEVERITY_ORDER[worst.severity] ?? 0)) worst = f;
    }
    decision = SEVERITY_TO_DECISION[worst.severity] ?? "quarantine";
  }

  const elapsed = Date.now() - start;
  return {
    decision,
    findings: kept,
    channel,
    latency_ms: elapsed > 0 ? elapsed : null,
  };
}

export const STATS = {
  // Carriers only — this is the published number (version.json / the site).
  // Mechanisms are a different kind of thing and get their own line.
  patterns: PATTERNS.length,
  mechanisms: MECHANISMS.length,
  // KEYWORDS = DISTINCT ENTRIES IN THE LIVE PRE-SCREEN INDEX, which is exactly
  // `keywordToPatterns.size`, not the number of keyword strings the rules carry.
  //
  // This published 7,098 until 2026-09-14, the ENTRY total, while the pip
  // scanner published 6,675 under the index definition. Two different questions
  // wearing one word, and a visitor comparing the demo to the product saw a gap
  // that was not there. The index is keyed on `kw.toLowerCase()` and every
  // pattern regex is IGNORECASE, so two keywords differing only in case are ONE
  // entry: `X-Agent-Policy`/`x-agent-policy` and `Does not override`/`does not
  // override` are the only two such pairs, which is why a case-sensitive count
  // reads 6,677 and the index reads 6,675.
  keywords: keywordToPatterns.size,
  // Kept because it is a real quantity, named so it can never be mistaken for
  // the published one again.
  keyword_entries: keywordCount,
  regex_patterns: regexPatterns.length,
};
