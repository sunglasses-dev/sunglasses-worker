// Asks the runtime this worker runs on which code points it counts in each Unicode class, and compares the answer with
// the pinned tables (src/unicode_tables.js). It answers counts and ranges only: no scan, no state, no text in.
import { PINNED_UNICODE, UNICODE_PROPERTIES } from "../../src/unicode_tables.js";
import { assignedFlags, caseDigests, countAssigned, differingBlocks } from "../unicode_case_digest.js";
import CASE_FIXTURE from "../../tests/fixtures/unicode_case_digests.json";

const sha256hex = async (text) => {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
};

function runtimeRanges(name) {
  const rx = new RegExp("^\\p{" + name + "}$", "u");
  const out = [];
  let start = -1;
  for (let c = 0; c <= 0x110000; c++) {
    const hit = c <= 0x10ffff && !(c >= 0xd800 && c <= 0xdfff) && rx.test(String.fromCodePoint(c));
    if (hit && start < 0) start = c;
    else if (!hit && start >= 0) { out.push([start, c - 1]); start = -1; }
  }
  return out;
}
const members = (flat) => { const s = new Set(); for (let i = 0; i < flat.length; i += 2) for (let c = flat[i]; c <= flat[i + 1]; c++) if (c < 0xd800 || c > 0xdfff) s.add(c); return s; };
const hex = (c) => c.toString(16);
const spans = (cps) => { const out = []; for (const c of cps) { const l = out[out.length - 1]; if (l && l[1] === c - 1) l[1] = c; else out.push([c, c]); } return out.map(([a, b]) => (a === b ? hex(a) : hex(a) + "-" + hex(b))); };

export default {
  async fetch() {
    const pinned = {};
    const report = { pinned_unicode: PINNED_UNICODE, classes: {} };
    for (const name of Object.keys(UNICODE_PROPERTIES)) {
      const table = members(UNICODE_PROPERTIES[name]);
      const runtime = members(runtimeRanges(name).flat());
      const runtimeOnly = [...runtime].filter((c) => !table.has(c));
      const tableOnly = [...table].filter((c) => !runtime.has(c));
      report.classes[name] = { table: table.size, runtime: runtime.size, runtime_only: runtimeOnly.length, table_only: tableOnly.length, runtime_only_ranges: spans(runtimeOnly), table_only_ranges: spans(tableOnly).slice(0, 40) };
    }
    // the letter and number class under the rule's own spelling, spot code points from the ranges that differ between Unicode versions, on this runtime
    const ln = new RegExp("^[\\p{L}\\p{N}]$", "u");
    const sample = [0x88f, 0xc5c, 0xcdc, 0xa7ce, 0xa7d2, 0xa7f1, 0x10940, 0x16ea0, 0x1e6c0];
    report.letter_or_number_samples = Object.fromEntries(sample.map((c) => [hex(c), ln.test(String.fromCodePoint(c))]));
    report.runtime_lower_of_a7ce = hex("꟎".toLowerCase().codePointAt(0));
    report.runtime_nfkc_of_a7f1 = hex("꟱".normalize("NFKC").codePointAt(0));
    // lower case and NFKC of every code point the pinned tables assign, one digest per block, beside the digests the pinned
    // interpreter wrote (tests/fixtures/unicode_case_digests.json): differ lists the blocks that are not equal
    const assigned = assignedFlags(UNICODE_PROPERTIES.Cn);
    const digests = await caseDigests(assigned, sha256hex);
    report.lower_nfkc = {
      block_size: CASE_FIXTURE.block_size, pinned_python: CASE_FIXTURE.python, assigned: countAssigned(assigned),
      assigned_pinned: CASE_FIXTURE.assigned, differ: differingBlocks(digests, CASE_FIXTURE.blocks), digests,
    };
    return new Response(JSON.stringify(report), { headers: { "content-type": "application/json" } });
  },
};
