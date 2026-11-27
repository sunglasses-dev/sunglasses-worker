// A rule may carry `channel_severity`: a lower severity on the channels it names (engine.py `_read_channel_severity` and
// `_lowered_on_channel`, scanner 0.6.29). The Worker reads the same field from the compiled record. Its own severity stays
// on every other channel; a field that is not a mapping of known channels to a lower severity is refused at load.
//   node --test tests/channel_severity.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const enginePath = process.env.SG_WORKER_ENGINE
  || path.resolve(path.dirname(new URL(import.meta.url).pathname), "../src/engine.js");
const { readChannelSeverity, lowerForChannel, scan, CHANNEL_SEVERITY } = await import(pathToFileURL(enginePath).href);

const RULE = { id: "X-1", severity: "medium", channel_severity: { file: "low", web_content: "low" } };
const table = readChannelSeverity([RULE]);
const hit = () => ({ decision: "quarantine", findings: [{ id: "X-1", severity: "medium" }] });

test("a named channel carries the lower severity and the decision follows it", () => {
  const out = lowerForChannel(hit(), "file", table);
  assert.equal(out.findings[0].severity, "low");
  assert.equal(out.findings[0].original_severity, "medium");
  assert.equal(out.decision, "allow_redacted");
});

test("a channel the field does not name keeps the rule's own severity", () => {
  const out = lowerForChannel(hit(), "message", table);
  assert.equal(out.findings[0].severity, "medium");
  assert.equal(out.findings[0].original_severity, undefined);
  assert.equal(out.decision, "quarantine");
});

test("an alias channel reads the canonical channel's entry (code -> file)", () => {
  assert.equal(lowerForChannel(hit(), "code", table).findings[0].severity, "low");
});

test("a worse finding of another rule still decides", () => {
  const r = { decision: "block", findings: [{ id: "X-1", severity: "medium" }, { id: "Y-9", severity: "high" }] };
  const out = lowerForChannel(r, "file", table);
  assert.equal(out.findings[0].severity, "low");
  assert.equal(out.decision, "block");
});

test("it only lowers: a finding already at or below the lower severity is left alone", () => {
  const r = { decision: "allow_redacted", findings: [{ id: "X-1", severity: "low" }] };
  assert.equal(lowerForChannel(r, "file", table), r);
});

test("a result with no such finding comes back as it is", () => {
  const r = { decision: "block", findings: [{ id: "Y-9", severity: "high" }] };
  assert.equal(lowerForChannel(r, "file", table), r);
  assert.equal(lowerForChannel(r, "file", new Map()), r);
});

test("a field that is not a mapping, an unknown channel, or a severity that does not rank below is refused at load", () => {
  const bad = (cs, sev = "medium") => () => readChannelSeverity([{ id: "B", severity: sev, channel_severity: cs }]);
  assert.throws(bad({}), /must be a mapping/);
  assert.throws(bad("low"), /must be a mapping/);
  assert.throws(bad(["file"]), /must be a mapping/);
  assert.throws(bad(null), /must be a mapping/);
  assert.throws(bad({ nope: "low" }), /unknown channel/);
  assert.throws(bad({ file: "medium" }), /does not rank below/);
  assert.throws(bad({ file: "high" }), /does not rank below/);
  assert.throws(bad({ file: "review" }), /does not rank below/);
  assert.throws(bad({ file: "bogus" }), /does not rank below/);
});

test("the shipped rule set loads, and scan() still answers on every channel", () => {
  assert.ok(CHANNEL_SEVERITY instanceof Map);
  for (const ch of ["message", "file", "web_content"]) {
    const out = scan("hello world", ch);
    assert.equal(out.decision, "allow");
  }
});
