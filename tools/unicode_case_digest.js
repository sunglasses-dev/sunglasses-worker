// A digest per block of what lower case and compatibility normalization (NFKC) make of every code point the pinned
// tables assign. compile_unicode_case_digests.py writes the same digests from the interpreter the tables are measured on;
// the test in this repository and the edge probe compute them from the runtime they run on and compare. One line per
// assigned code point: the code point, its lower case, its NFKC form, each as hex code points, so a block's digest is a
// plain hash of text that Python writes the same way.
export const BLOCK_SIZE = 1024;

const hexList = (s) => Array.from(s, (ch) => ch.codePointAt(0).toString(16)).join(",");

// The scalar values (surrogates out) that the pinned tables do not list as unassigned, as a flag per code point.
export function assignedFlags(unassignedFlat) {
  const flags = new Uint8Array(0x110000).fill(1);
  flags.fill(0, 0xd800, 0xe000);
  for (let i = 0; i < unassignedFlat.length; i += 2) flags.fill(0, unassignedFlat[i], unassignedFlat[i + 1] + 1);
  return flags;
}

export function blockText(start, assigned, lower, nfkc) {
  let out = "";
  const end = Math.min(start + BLOCK_SIZE, 0x110000);
  for (let c = start; c < end; c++) {
    if (!assigned[c]) continue;
    const ch = String.fromCodePoint(c);
    out += c.toString(16) + " " + hexList(lower(ch)) + " " + hexList(nfkc(ch)) + "\n";
  }
  return out;
}

// { block start (hex): digest } for every block that holds an assigned code point. sha256hex(text) answers the hex
// SHA-256 of the text, sync or async (node:crypto in a test, crypto.subtle on the edge).
export async function caseDigests(assigned, sha256hex, lower = (s) => s.toLowerCase(), nfkc = (s) => s.normalize("NFKC")) {
  const out = {};
  for (let start = 0; start < 0x110000; start += BLOCK_SIZE) {
    const text = blockText(start, assigned, lower, nfkc);
    if (text) out[start.toString(16)] = await sha256hex(text);
  }
  return out;
}

export function countAssigned(assigned) {
  let n = 0;
  for (let c = 0; c < assigned.length; c++) n += assigned[c];
  return n;
}

// The blocks where two digest maps differ (a block in one and not the other counts), as hex starts in order.
export function differingBlocks(a, b) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort((x, y) => parseInt(x, 16) - parseInt(y, 16));
}
