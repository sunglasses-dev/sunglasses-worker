// Did a recompile change the RULES, or only the stamp and the anchor order?
//
// Text diff cannot answer this: PATTERNS is one enormous line, so any change
// anywhere reports the whole array as different. And the compiler's anchor
// extraction is ORDER UNSTABLE. Rebuilding identical sources permutes a few
// `anchors` arrays, which ASTRA also observed ("zero compiled-record differences
// after canonicalizing anchor order"). A comparison that did not canonicalize
// would call every rebuild a rule change and this gate would cry wolf until
// someone stopped reading it.
//
// Same set in a different order is not a behaviour change: the engine tests
// anchor membership, not position. A changed MEMBER is a real change and is
// reported.
const [beforePath, afterPath] = process.argv.slice(2);
const a = await import(beforePath);
const b = await import(afterPath);
const canon = (p) =>
  JSON.stringify(p, (k, v) => (k === "anchors" && Array.isArray(v) ? [...v].sort() : v));
const ai = new Map(a.PATTERNS.map((p) => [p.id, canon(p)]));
const bi = new Map(b.PATTERNS.map((p) => [p.id, canon(p)]));
const changed = [...bi.keys()].filter((k) => ai.has(k) && ai.get(k) !== bi.get(k));
const added = [...bi.keys()].filter((k) => !ai.has(k));
const removed = [...ai.keys()].filter((k) => !bi.has(k));
const permuted = [...bi.keys()].filter(
  (k) => ai.has(k) && ai.get(k) === bi.get(k) &&
    JSON.stringify(a.PATTERNS.find((p) => p.id === k)) !==
    JSON.stringify(b.PATTERNS.find((p) => p.id === k)));
console.log(`  rules before ${a.PATTERNS.length}  after ${b.PATTERNS.length}`);
console.log(`  anchor-order only (no behaviour change): ${permuted.length}`);
console.log(`  changed ${changed.length}  added ${added.length}  removed ${removed.length}`);
if (changed.length || added.length || removed.length) {
  console.log("  CHANGED: " + changed.slice(0, 10).join(", "));
  console.log("  ADDED:   " + added.slice(0, 10).join(", "));
  console.log("  REMOVED: " + removed.slice(0, 10).join(", "));
  process.exit(1);
}
