// Lower case and compatibility normalization (NFKC) of an assigned character are computed by the runtime. This test holds
// them equal to the pinned Unicode version: for every code point the pinned tables assign, the runtime's lower case and
// NFKC form are compared, block by block, with a digest written by the interpreter the tables are measured on
// (compile_unicode_case_digests.py -> tests/fixtures/unicode_case_digests.json). 0 blocks differ.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PINNED_UNICODE, lowerPinned, nfkcPinned } from "../src/pinned.js";
import { UNICODE_PROPERTIES } from "../src/unicode_tables.js";
import { BLOCK_SIZE, assignedFlags, caseDigests, countAssigned, differingBlocks } from "../tools/unicode_case_digest.js";

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/unicode_case_digests.json", import.meta.url), "utf8"));
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const assigned = assignedFlags(UNICODE_PROPERTIES.Cn);
const major = (v) => v.split(".").map(Number);
const [a, b] = major(process.versions.unicode), [c, d] = major(PINNED_UNICODE);
const skip = !(a > c || (a === c && b >= d)) && "this runtime reads an older Unicode than the tables";

test("the fixture is the pinned version's, and holds a block for every block of assigned code points", () => {
  assert.equal(FIXTURE.unicode, PINNED_UNICODE);
  assert.equal(FIXTURE.block_size, BLOCK_SIZE);
  assert.equal(FIXTURE.assigned, countAssigned(assigned));
  assert.ok(Object.keys(FIXTURE.blocks).length > 250);
});

test("lower case of every assigned code point, as the Worker computes it, equals the pinned interpreter's, block by block", { skip }, async () => {
  const got = await caseDigests(assigned, sha, lowerPinned, (s) => s.normalize("NFKC"));
  assert.deepEqual(differingBlocks(got, FIXTURE.blocks), []);
});

test("NFKC of every assigned code point, as the Worker computes it, equals the pinned interpreter's, block by block", { skip }, async () => {
  const got = await caseDigests(assigned, sha, (s) => s.toLowerCase(), nfkcPinned);
  assert.deepEqual(differingBlocks(got, FIXTURE.blocks), []);
});

test("the runtime's own lower case and NFKC agree with the fixture on every assigned code point too", { skip }, async () => {
  assert.deepEqual(differingBlocks(await caseDigests(assigned, sha), FIXTURE.blocks), []);
});

test("the compare sees one wrong answer: a changed lower case or NFKC form moves exactly its own block", async () => {
  const honest = await caseDigests(assigned, sha, (s) => s.toLowerCase(), (s) => s.normalize("NFKC"));
  const lowerOff = await caseDigests(assigned, sha, (s) => (s === "\u{a7c0}" ? "x" : s.toLowerCase()), (s) => s.normalize("NFKC"));
  assert.deepEqual(differingBlocks(lowerOff, honest), [(0xa7c0 - (0xa7c0 % BLOCK_SIZE)).toString(16)]);
  const nfkcOff = await caseDigests(assigned, sha, (s) => s.toLowerCase(), (s) => (s === "\u{ff21}" ? "a" : s.normalize("NFKC")));
  assert.deepEqual(differingBlocks(nfkcOff, honest), [(0xff21 - (0xff21 % BLOCK_SIZE)).toString(16)]);
  // an unassigned code point is not in any digest: a runtime that adds a case pair for one leaves every block as it was
  const unassignedCp = 0x32ca4;
  assert.equal(assigned[unassignedCp], 0);
  const extra = await caseDigests(assigned, sha, (s) => (s === String.fromCodePoint(unassignedCp) ? "x" : s.toLowerCase()), (s) => s.normalize("NFKC"));
  assert.deepEqual(differingBlocks(extra, honest), []);
});
