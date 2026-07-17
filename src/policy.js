// policy.js — MIRROR of the pip scanner's sunglasses/policy.py.
// Keep in lockstep: the policy parity gate (policy_parity.py) compares this
// module's rollup against the Python reference on synthetic finding sets.
//
//   "The engine reports findings. A single policy layer decides the action
//    per surface and mode. BLOCK is only shown where we actually block
//    model input."                            (verdict redesign, Jul 17 2026)
//
// Enforcement surfaces (paste scan) keep engine.js's worst-severity decision.
// Repo scans are display surfaces and grade on the ladder:
//   clean / clean_notes / review_before_agent_ingestion / known_attack
// Red (known_attack) is reachable ONLY via the curated Tier-S signature set,
// which ships empty — an ordinary pattern can never paint red.
import { PATTERNS } from "./patterns.js";

// Tier-S: curated known-attack signatures — the only red-capable set.
export const TIER_S_SIGNATURE_IDS = new Set();

// Tier-B: keyword-only patterns (compiled with an empty regex list) — hints
// that feed notes, never verdicts. NOTE: Python tests `not p.get("regex")`;
// the compiled JS shape is an ARRAY, so emptiness must be length-checked.
const KEYWORD_ONLY_IDS = new Set(
  PATTERNS.filter((p) => !p.regex || p.regex.length === 0).map((p) => p.id),
);

const CORROBORATING_SEVERITIES = new Set(["high", "critical"]);

export const BOUNDARY_LABEL = "Agent-context decision, not repo reputation.";

export function isNoteOnly(finding) {
  if (KEYWORD_ONLY_IDS.has(finding.id)) return true;
  if (!CORROBORATING_SEVERITIES.has(finding.severity)) return true;
  return false;
}

// Grade a repo scan on the ladder. files = [{name, findings}, ...]
export function rollupRepo(files, tierS = TIER_S_SIGNATURE_IDS) {
  let overall = "clean";
  const notes = [];
  const review = [];
  const signatureHits = [];

  for (const f of files) {
    const name = f.name ?? "?";
    const findings = f.findings ?? [];
    for (const finding of findings) {
      const entry = {
        file: name,
        id: finding.id,
        severity: finding.severity,
        category: finding.category ?? "",
        matched_text: finding.matched_text ?? "",
      };
      if (tierS.has(finding.id)) signatureHits.push(entry);
      else notes.push(entry);
    }

    // Corroboration: 2+ DISTINCT pattern ids on 2+ DISTINCT text spans,
    // SAME category, each high+ regex-confirmed, in THIS file. Distinct
    // categories scattered through prose (the mempalace shape) never
    // corroborate, and two patterns matching the SAME span (the claude-seo
    // shape) are one piece of evidence, not two independent witnesses.
    const byCategory = new Map();
    for (const finding of findings) {
      if (isNoteOnly(finding) || tierS.has(finding.id)) continue;
      if (!byCategory.has(finding.category)) byCategory.set(finding.category, { ids: new Set(), spans: new Set() });
      const g = byCategory.get(finding.category);
      g.ids.add(finding.id);
      g.spans.add(finding.matched_text ?? "");
    }
    const corroborated = [...byCategory.entries()]
      .filter(([, g]) => g.ids.size >= 2 && g.spans.size >= 2)
      .map(([cat]) => cat);
    if (corroborated.length) review.push({ file: name, categories: corroborated });
  }

  if (signatureHits.length) overall = "known_attack";
  else if (review.length) overall = "review_before_agent_ingestion";
  else if (notes.length) overall = "clean_notes";

  return {
    overall,
    boundary: BOUNDARY_LABEL,
    notes,
    review,
    signature_hits: signatureHits,
    files_scanned: files.length,
  };
}
