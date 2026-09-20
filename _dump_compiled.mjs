// Dump the compiled artefact as JSON on stdout so a Python gate can compare it
// against the tagged Python source. Reading patterns.js textually is not an
// option: PATTERNS is one enormous single line.
const [p] = process.argv.slice(2);
const m = await import(p);
process.stdout.write(JSON.stringify({
  patterns_version: m.PATTERNS_VERSION ?? null,
  compiled_from: m.COMPILED_FROM ?? null,
  patterns: m.PATTERNS,
}));
