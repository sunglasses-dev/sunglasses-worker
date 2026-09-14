// Sunglasses Worker — engine port of sunglasses/engine.py scan() (v0.4.9).
// Same lanes, same order: keyword index on NORMALIZED text, regexes on RAW text,
// negation window, worst-severity decision.
import { MECHANISMS } from "./mechanisms.js";
import { PATTERNS } from "./patterns.js";
import { normalize, VIEW_SEP } from "./preprocessor.js";

const SEVERITY_ORDER = { critical: 4, high: 3, medium: 2, low: 1, review: 0 };
const SEVERITY_TO_DECISION = {
  critical: "block",
  high: "block",
  medium: "quarantine",
  low: "allow_redacted",
  review: "allow_redacted",
};

// Split mirrors engine.py: TRUE_NEGATIONS defuse a payload and always downgrade;
// FRAMING_LABELS only label it, so they downgrade ONLY when the payload is
// presented illustratively (quoted/fenced) — a bare imperative after a label is
// a smuggle attempt and is NOT downgraded.
const TRUE_NEGATIONS = [
  "do not", "don't", "don’t", "dont",
  "never", "avoid", "be careful", "watch out for",
  "beware of", "not run", "not execute", "not use",
  "should not", "shouldn't", "shouldn’t",
  "must not", "must never",
];
const FRAMING_LABELS = [
  "warning:", "warning -", "example of", "example:",
  "for example", "caution:", "note:",
];
const QUOTE_CHARS = "\"'`“”‘’«»";
const NEGATION_WINDOW = 50;

// DEFENSIVE FRAMING — mechanisms only (port of engine.py DEFENSIVE_FRAMING).
// A shape rule also matches prose DESCRIBING the shape: "this scanner detects
// attempts to exfiltrate API keys to an external server" is a README, not an
// attack. Downgrades to `review`, never discards, and is scoped to the payload's
// own sentence so one "detects" in an intro cannot defuse the whole document.
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
const DEFENSIVE_WINDOW = 120;

function isDefensivelyFramed(text, matchStart) {
  let before = text.slice(Math.max(0, matchStart - DEFENSIVE_WINDOW), matchStart).toLowerCase();
  for (const stop of [". ", "! ", "? ", "\n"]) {
    const idx = before.lastIndexOf(stop);
    if (idx !== -1) before = before.slice(idx + stop.length);
  }
  return DEFENSIVE_FRAMING.some((p) => before.includes(p));
}

// Locality rule for whole-document co-occurrence predicates — port of
// engine.py _match_windowed (PR #69). Anchored (lookahead-led) predicates are
// evaluated per overlapping window so their (?=.*A)(?=.*B) signals must
// co-occur LOCALLY; spreading matching words across a 30KB README no longer
// fires. Sticky-flag exec at lastIndex=0 on a slice == Python rx.match().
const COOCCUR_WINDOW = 1200;
const COOCCUR_STRIDE = 600;

// Step 3.5 length gate — port of engine.py CORROBORATE_NORM_MAX (v0.3.3).
const CORROBORATE_NORM_MAX = 2000;

function matchWindowed(rx, text) {
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

function matchAnchored(entry, text) {
  const { anchors, span } = entry;
  const length = text.length;
  const folded = fold(text);
  // A position found in a differently sized string points somewhere else in the
  // document. engine.py searches everything rather than guess; so does this.
  if (folded.length !== length) return searchBounded(entry, text, 0, length);

  // A document can be MADE of the anchor, and then the merged windows cover it
  // and anchoring saves nothing. Stop as soon as that is known: the threshold is
  // one more than the number of non-overlapping windows of width `span` that fit.
  const budget = Math.floor(length / Math.max(span, 1)) + 1;
  const spots = [];
  for (const term of anchors) {
    let at = folded.indexOf(term);
    while (at !== -1) {
      spots.push(at);
      if (spots.length > budget) return searchBounded(entry, text, 0, length);
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
    let pos = wlo;
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

// `pos`/`endpos` have no JS equivalent, so the start is bounded with lastIndex
// and the end by rejecting a match that runs past it. NOT identical to Python:
// with a real endpos the engine could find a SHORTER alternative that fits,
// where this rejects and the caller advances one character and tries again.
// The differential over the whole corpus is what decides whether that gap is
// observable, and it is reported rather than assumed.
function searchBounded(entry, text, pos, stop) {
  const rx = entry.rxGlobal;
  rx.lastIndex = pos;
  let m;
  while ((m = rx.exec(text)) !== null) {
    if (m.index >= stop) return null;
    if (m.index + m[0].length <= stop) return m;
    rx.lastIndex = m.index + 1;
  }
  return null;
}

function matchAt(entry, text, at) {
  const rx = entry.rxSticky;
  rx.lastIndex = at;
  return rx.exec(text);
}

function evalRegex(entry, text) {
  if (entry.mode === "anchored") return matchAnchored(entry, text);
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
        const sticky = r.mode !== "plain" && r.mode !== "anchored";
        const entry = {
          mode: r.mode,
          rx: new RegExp(r.source, r.flags + (sticky ? "y" : "")),
          guards: (r.guards || []).map((g) => new RegExp(g.source, g.flags + "y")),
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
  if (end < text.length && ALNUM.test(keyword.slice(-1)) && ALNUM.test(text[end])) return false;
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
  let start = Math.max(0, kwStart - 10);
  let end = Math.min(normalized.length, kwEnd + 20);
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

function checkNegation(text, matchStart) {
  const windowStart = Math.max(0, matchStart - NEGATION_WINDOW);
  const before = text.slice(windowStart, matchStart).toLowerCase();
  if (TRUE_NEGATIONS.some((ph) => before.includes(ph))) return true;
  for (const ph of FRAMING_LABELS) {
    const pos = before.lastIndexOf(ph);
    if (pos !== -1) {
      const gap = before.slice(pos + ph.length);
      if ([...QUOTE_CHARS].some((q) => gap.includes(q))) return true;
    }
  }
  return false;
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
  const normalized = normalize(text);
  const findings = [];
  const seen = new Set();

  // Lane 1 — keywords on normalized text (substring containment, same as the
  // engine's dependency-free fallback path). v0.3.3: a keyword hit on a
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
      if (seen.has(pattern.id) || candidates.has(pattern.id)) continue;
      if (regexBearingIds.has(pattern.id)) {
        candidates.set(pattern.id, pattern);
        continue;
      }
      seen.add(pattern.id);
      const matched = excerpt(normalized, idx, idx + keyword.length);
      const negated = !pattern.negation_immune && checkNegation(normalized, idx);
      findings.push(makeFinding(pattern, matched, negated));
    }
  }

  // Lane 2 — regexes on RAW text (same as engine.py step 3).
  for (const { pattern, compiled } of regexPatterns) {
    if (!channelHit(pattern)) continue;
    if (seen.has(pattern.id)) continue;
    for (const entry of compiled) {
      const m = evalRegex(entry, text);
      if (m) {
        seen.add(pattern.id);
        // NOTE: for windowed matches m.index is slice-relative — Python has the
        // IDENTICAL behavior (match.start() is window-relative in _match_windowed
        // results). Do NOT "fix" by adding the window offset; parity depends on
        // mirroring engine.py exactly.
        const negated = !pattern.negation_immune && checkNegation(text, m.index);
        // Mechanisms only, and only when negation did not already fire — mirrors
        // the if/elif ordering in engine.py.
        const defensive =
          !negated &&
          pattern.id.startsWith("GLS-MECH-") &&
          isDefensivelyFramed(text, m.index);
        findings.push(makeFinding(pattern, m[0].slice(0, 50), negated, defensive));
        break;
      }
    }
  }

  // Lane 2.5 — corroboration pass (port of engine.py step 3.5, v0.3.3): a
  // candidate still unconfirmed after the raw-text lane gets one regex try on
  // the NORMALIZED view — where homoglyph/ROT13/leet folds live — so encoded
  // evasions still corroborate. Short inputs only (same reasoning as the
  // preprocessor's enrichment gate: encoding evasions live in short crafted
  // payloads; a long document's compacted normalized view re-creates the
  // spread-text FPs the window exists to prevent). A candidate whose regex
  // fires on neither view is a keyword-only echo and is dropped.
  if (text.length <= CORROBORATE_NORM_MAX) {
    for (const [pid, pattern] of candidates) {
      if (seen.has(pid)) continue;
      for (const entry of compiledById.get(pid) || []) {
        const m = evalRegex(entry, normalized);
        if (m) {
          seen.add(pid);
          const negated = !pattern.negation_immune && checkNegation(normalized, m.index);
          findings.push(makeFinding(pattern, m[0].slice(0, 50), negated));
          break;
        }
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
  keywords: keywordCount,
  regex_patterns: regexPatterns.length,
};
