// Sunglasses Worker — engine port of sunglasses/engine.py scan() (v0.2.73).
// Same lanes, same order: keyword index on NORMALIZED text, regexes on RAW text,
// negation window, worst-severity decision.
import { PATTERNS } from "./patterns.js";
import { normalize } from "./preprocessor.js";

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

// Locality rule for whole-document co-occurrence predicates — port of
// engine.py _match_windowed (PR #69). Anchored (lookahead-led) predicates are
// evaluated per overlapping window so their (?=.*A)(?=.*B) signals must
// co-occur LOCALLY; spreading matching words across a 30KB README no longer
// fires. Sticky-flag exec at lastIndex=0 on a slice == Python rx.match().
const COOCCUR_WINDOW = 1200;
const COOCCUR_STRIDE = 600;

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

// ── Index build (once per isolate) ──────────────────────────────────────────
const keywordToPatterns = new Map();
const regexPatterns = [];
let keywordCount = 0;

for (const p of PATTERNS) {
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
        // Anchored whole-document predicates run once at position 0 via sticky
        // flag (mirrors Python .match) — the ReDoS guard from engine.py.
        compiled.push({ rx: new RegExp(r.source, r.flags + (r.anchored ? "y" : "")), anchored: r.anchored });
      } catch { /* validated at compile time; never expected */ }
    }
    if (compiled.length) regexPatterns.push({ pattern: p, compiled });
  }
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

function makeFinding(pattern, matchedText, negated) {
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
  }
  return f;
}

export function scan(text, channel = "message") {
  // NOTE: Cloudflare freezes Date.now() during synchronous execution (timing-attack
  // defense), so a pure-CPU scan measures 0ms in production. We return null rather
  // than a fake number; the UI hides it. Real timing lives in CF's own metrics.
  const start = Date.now();
  const normalized = normalize(text);
  const findings = [];
  const seen = new Set();

  // Lane 1 — keywords on normalized text (substring containment, same as the
  // engine's dependency-free fallback path).
  for (const [keyword, patterns] of keywordToPatterns) {
    const idx = normalized.indexOf(keyword);
    if (idx === -1) continue;
    for (const pattern of patterns) {
      if (!(pattern.channel || []).includes(channel)) continue;
      if (seen.has(pattern.id)) continue;
      seen.add(pattern.id);
      const excerpt = normalized.slice(Math.max(0, idx - 10), Math.min(normalized.length, idx + keyword.length + 20));
      const negated = !pattern.negation_immune && checkNegation(normalized, idx);
      findings.push(makeFinding(pattern, excerpt, negated));
    }
  }

  // Lane 2 — regexes on RAW text (same as engine.py step 3).
  for (const { pattern, compiled } of regexPatterns) {
    if (!(pattern.channel || []).includes(channel)) continue;
    if (seen.has(pattern.id)) continue;
    for (const { rx, anchored } of compiled) {
      let m;
      if (anchored) {
        m = matchWindowed(rx, text);
      } else {
        rx.lastIndex = 0;
        m = rx.exec(text);
      }
      if (m) {
        seen.add(pattern.id);
        // NOTE: for windowed matches m.index is slice-relative — Python has the
        // IDENTICAL behavior (match.start() is window-relative in _match_windowed
        // results). Do NOT "fix" by adding the window offset; parity depends on
        // mirroring engine.py exactly.
        const negated = !pattern.negation_immune && checkNegation(text, m.index);
        findings.push(makeFinding(pattern, m[0].slice(0, 50), negated));
        break;
      }
    }
  }

  // Decision = worst finding severity.
  let decision = "allow";
  if (findings.length) {
    let worst = findings[0];
    for (const f of findings) {
      if ((SEVERITY_ORDER[f.severity] ?? 0) > (SEVERITY_ORDER[worst.severity] ?? 0)) worst = f;
    }
    decision = SEVERITY_TO_DECISION[worst.severity] ?? "quarantine";
  }

  const elapsed = Date.now() - start;
  return {
    decision,
    findings,
    channel,
    latency_ms: elapsed > 0 ? elapsed : null,
  };
}

export const STATS = {
  patterns: PATTERNS.length,
  keywords: keywordCount,
  regex_patterns: regexPatterns.length,
};
