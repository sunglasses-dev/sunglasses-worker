// One key, one process. argv: <workdir> <key> <cases.json>. Prints JSON.
import { readFileSync } from "node:fs";
import { join } from "node:path";
const [work, key, casesPath] = process.argv.slice(2);
const cases = JSON.parse(readFileSync(casesPath, "utf8"));
const b = await import(`file://${join(work, "base", "engine.js")}`);
const m = await import(`file://${join(work, `mut_${key}`, "engine.js")}`);
let idDelta = 0, recordDelta = 0, decisionDelta = 0;
const examples = [];
for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  const x = b.scan(c.text, c.channel), y = m.scan(c.text, c.channel);
  const ids = (r) => r.findings.map((f) => f.id).sort();
  if (JSON.stringify(ids(x)) !== JSON.stringify(ids(y))) {
    idDelta++;
    if (examples.length < 3) examples.push({ case: c.name ?? i, added: ids(y).filter((z) => !ids(x).includes(z)), removed: ids(x).filter((z) => !ids(y).includes(z)) });
  }
  if (JSON.stringify(x.findings) !== JSON.stringify(y.findings)) recordDelta++;
  if (x.decision !== y.decision) decisionDelta++;
}
process.stdout.write(JSON.stringify({ key, cases: cases.length, idDelta, recordDelta, decisionDelta, examples }));
