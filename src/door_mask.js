// The marker a finding of a secret shows where the hosted scan prints or returns the words it matched.
//
// Port of the scanner's sunglasses/door_mask.py. A finding of a secret class shows a MARKER
//
//     first 4 characters, the length, the rule id, a short digest   e.g.  AKIA… [20 characters, GLS-SD-003, 1f0ab3c7]
//
// enough to find the secret in the text the person sent, and to tell two findings apart. The digest is the first 8
// characters of the SHA-256 of the whole match, so the same secret reads the same marker twice. The words of a finding
// that is not a secret lose the characters of a secret found in the same scan. There is no second marker form: the answer of the text scan
// passes through maskDocument below and the answer of the repo scan through maskReport.
import { lowerPinned } from "./pinned.js";
import { decodeLeetspeak } from "./preprocessor.js";

const SECRET_CATEGORY = "secret_detection";
const SECRET_ID_PREFIX = "GLS-SD-";
const DIGEST_CHARS = 8;
const EDGE_MIN = 3;
const ELLIPSIS = "…";

// SHA-256 over the UTF-8 bytes of a string, synchronous, so the marker can be built wherever a finding is built.
// A lone surrogate is written as three bytes, as Python's "surrogatepass" does.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function utf8Bytes(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

export function sha256Hex(text) {
  const bytes = utf8Bytes(text);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const hi = Math.floor(bitLen / 0x100000000), lo = bitLen >>> 0;
  for (const w of [hi, lo]) bytes.push((w >>> 24) & 255, (w >>> 16) & 255, (w >>> 8) & 255, w & 255);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = (bytes[off + 4 * i] << 24) | (bytes[off + 4 * i + 1] << 16) | (bytes[off + 4 * i + 2] << 8) | bytes[off + 4 * i + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}

export const digest = (matched) => sha256Hex(matched).slice(0, DIGEST_CHARS);

export function mask(matched, ruleId) {
  const points = Array.from(matched);
  return `${points.slice(0, 4).join("")}${ELLIPSIS} [${points.length} characters, ${ruleId ?? "None"}, ${digest(matched)}]`;
}

const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

export function isSecretFinding(finding) {
  if (!isObject(finding)) return false;
  if (finding.category === SECRET_CATEGORY) return true;
  return typeof finding.id === "string" && finding.id.startsWith(SECRET_ID_PREFIX);
}

export function secretStrings(findings) {
  const out = [];
  for (const f of findings || []) {
    if (!isSecretFinding(f)) continue;
    const matched = f.matched_text;
    if (typeof matched === "string" && Array.from(matched).length >= EDGE_MIN && !out.includes(matched)) out.push(matched);
  }
  return out;
}

const stripEllipsis = (s) => s.replace(/^…+|…+$/g, "");

export function cleanWindow(text, secrets) {
  if (typeof text !== "string" || !text || !secrets || !secrets.length) return text;
  let out = text;
  const keys = [];
  for (const secret of secrets) {
    const lowered = lowerPinned(secret);
    for (const key of [lowered, decodeLeetspeak(lowered)]) if (!keys.includes(key)) keys.push(key);
  }
  for (const key of keys) {
    let low = lowerPinned(out);
    let at = low.indexOf(key);
    while (at !== -1) {                                    // the whole secret
      out = out.slice(0, at) + ELLIPSIS + out.slice(at + key.length);
      low = lowerPinned(out);
      at = low.indexOf(key);
    }
    if (low.length >= EDGE_MIN && stripEllipsis(low) && key.includes(stripEllipsis(low))) {   // the window lies inside the key
      out = ELLIPSIS;
      continue;
    }
    for (let k = Math.min(low.length, key.length - 1); k > EDGE_MIN - 1; k--) {    // the window starts with the end of the key
      if (low.startsWith(key.slice(key.length - k))) { out = ELLIPSIS + out.slice(k); break; }
    }
    low = lowerPinned(out);
    for (let k = Math.min(low.length, key.length - 1); k > EDGE_MIN - 1; k--) {    // the window ends with the start of the key
      if (low.endsWith(key.slice(0, k))) { out = out.slice(0, out.length - k) + ELLIPSIS; break; }
    }
  }
  return out;
}

function cutFinding(masked, original, secrets) {
  if (!isObject(masked) || isSecretFinding(original)) return masked;
  for (const key of ["matched_text", "shown_text"]) {
    if (typeof masked[key] === "string") masked[key] = cleanWindow(masked[key], secrets);
  }
  return masked;
}

// A copy of a JSON document (a scan result, a repo report) in which every finding of a secret class shows a mask in
// matched_text and shown_text. Findings listed side by side are one scan: a secret among them cuts the windows of
// the others. Everything else is the same value.
export function maskDocument(doc) {
  if (Array.isArray(doc)) return doc.map(maskDocument);
  if (!isObject(doc)) return doc;
  const out = {};
  const listed = doc.findings;
  const secrets = Array.isArray(listed) ? secretStrings(listed) : [];
  for (const [key, value] of Object.entries(doc)) {
    if (secrets.length && key === "findings" && Array.isArray(value)) {
      out[key] = value.map((v) => cutFinding(maskDocument(v), v, secrets));
    } else {
      out[key] = maskDocument(value);
    }
  }
  if (typeof out.matched_text === "string" && isSecretFinding(out)) {
    const full = doc.matched_text;
    out.matched_text = mask(full, out.id);
    if (typeof out.shown_text === "string" && out.shown_text) out.shown_text = mask(full, out.id);
  }
  return out;
}

// A repo report is one scan of each file it lists. maskDocument masks the secret findings wherever they stand, and
// cuts the windows of the findings listed beside them; the policy lists (notes, signature_hits) carry a span of
// findings too, so the span of a finding that is not a secret loses the characters of a secret found in the SAME file.
export function maskReport(doc) {
  const out = maskDocument(doc);
  if (!isObject(doc) || !Array.isArray(doc.files)) return out;
  const byFile = new Map(doc.files.filter(isObject).map((f) => [f.path, secretStrings(f.findings)]));
  for (const list of ["notes", "signature_hits"]) {
    if (!Array.isArray(out[list])) continue;
    out[list] = out[list].map((entry) => {
      if (!isObject(entry) || isSecretFinding(entry) || typeof entry.matched_text !== "string") return entry;
      return { ...entry, matched_text: cleanWindow(entry.matched_text, byFile.get(entry.file) || []) };
    });
  }
  return out;
}
