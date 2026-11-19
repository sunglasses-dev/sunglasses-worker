// A runtime fact, not a rule: the serving runtime (workerd) must give a modifier group the meaning the
// regexp-modifiers spec gives it. `(?-i:)` switches case folding off for what is INSIDE it; an empty one
// changes nothing, so the class beside it keeps the i flag, in a lookbehind as everywhere else.
// workerd 1.20260301.1 and 1.20260714.1 (wrangler <= 4.112.0) dropped the flag for that class inside a
// lookbehind; 1.20260911.1 (wrangler 4.131.1, the pinned one) does not. The compiled rules use `(?-i:)`
// inside lookbehinds all over, so this test boots the pinned wrangler in --local mode and asks workerd.
// It fails on the bad runtime and passes on the pinned one. It also checks node gives the same answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROBE = fileURLToPath(new URL("./fixtures/runtime_regex_probe/", import.meta.url));
const WRANGLER = process.env.WRANGLER_BIN || ROOT + "node_modules/.bin/wrangler"; // WRANGLER_BIN: point at another wrangler to see the test fail on an older runtime

// [source, flags, text, index of the match or null]  -- the answers are the spec's, written by hand.
const CASES = [
  ["(?<!(?-i:)[i])ass", "iu", "Iass", null],  // [i] still matches I, so the negative lookbehind blocks
  ["(?<!(?-i:)[i])ass", "iu", "xass", 1],     // nothing before it: matches
  ["(?<=(?-i:)[i])ass", "iu", "Iass", 1],     // the positive form: [i] matches I, so it matches
  ["(?<!(?-i:)[i])ass", "u", "Iass", 1],      // without the i flag [i] is lowercase only: matches
  ["(?<!(?-i:)i )ass", "iu", "I ass", null],  // a plain letter: same answer on every runtime tested
];

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

test("regex answers: node and the pinned workerd agree with the spec", async () => {
  for (const [source, flags, text, want] of CASES) {
    const m = new RegExp(source, flags).exec(text);
    assert.equal(m ? m.index : null, want, `node: ${source} /${flags} on ${JSON.stringify(text)}`);
  }
  const port = await freePort();
  const inspector = await freePort();
  const child = spawn(WRANGLER, ["dev", "--local", "--port", String(port), "--inspector-port", String(inspector)], { cwd: PROBE, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  try {
    const deadline = Date.now() + 120_000;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      if (child.exitCode !== null) throw new Error("wrangler dev exited early:\n" + log.slice(-800));
      try { const r = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: JSON.stringify({ cases: [] }) }); ready = r.ok; } catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    assert.ok(ready, "wrangler dev did not come up:\n" + log.slice(-800));
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: JSON.stringify({ cases: CASES.map(([source, flags, text]) => ({ source, flags, text })) }) });
    const { out } = await res.json();
    CASES.forEach(([source, flags, text, want], i) => assert.equal(out[i], want, `workerd: ${source} /${flags} on ${JSON.stringify(text)}`));
  } finally {
    child.kill("SIGTERM");
  }
});
