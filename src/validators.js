// Structural validators: rules that read structure instead of matching characters. Port of the pip scanner's
// validators.py. A validator has the shape of a rule (id, name, category, severity, channel, description) and two
// methods: pregate(text) is a cheap substring test, and run(text) returns findings in the shape the pattern layer
// reports, plus `structural: true` and a small `evidence` object. The output depends on the text alone.
//
// The engine runs them after the pattern layers, on the raw text cut at the scan limit (see runValidators).

import { RegistryRedirectInShell } from "./registry_redirect.js";
import { HookFetchAndRun } from "./hook_fetch.js";

// ---------------------------------------------------------------------------------------------- shared helpers

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (o, key) => (Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined);

function finding(validator, matched, evidence) {
  return {
    id: validator.id,
    name: validator.name,
    category: validator.category,
    severity: validator.severity,
    channel: [...validator.channel],
    description: validator.description,
    matched_text: cpHead(matched, 50),
    structural: true,
    evidence,
  };
}

// The first `n` code points of a string, the way a Python slice reads it.
function cpHead(s, n) {
  if (s.length <= n) return s;
  let i = 0;
  let seen = 0;
  while (i < s.length && seen < n) {
    const c = s.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < s.length ? 2 : 1;
    seen += 1;
  }
  return s.slice(0, i);
}

// ----------------------------------------------------------------------------------------------- address reader

const IS_DIGITS = /^[0-9]+$/;

// An empty port, or ASCII digits whose value is at most 65535. Measured by digits, so a long run costs its length.
function isPort(text) {
  if (text === "") return true;
  if (!IS_DIGITS.test(text)) return false;
  const digits = text.replace(/^0+/, "");
  return digits.length <= 5 && Number(digits || "0") <= 65535;
}

// Four plain decimal parts, no leading zeros. The 32-bit value, or null.
function v4(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!(IS_DIGITS.test(part) && part.length <= 3 && Number(part) <= 255 && (part === "0" || part[0] !== "0"))) return null;
    value = value * 256 + Number(part);
  }
  return value;
}

const V4_NOT_PUBLIC = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
].map(([base, bits]) => [v4(base), 2 ** (32 - bits)]);

function v4NotPublic(value) {
  for (const [base, size] of V4_NOT_PUBLIC) if (value >= base && value < base + size) return true;
  return false;
}

const HEXTET = /^[0-9a-fA-F]{1,4}$/;

// The eight 16-bit groups of an IPv6 address, or null. Same grammar as Python's ipaddress.IPv6Address without a zone.
function v6(text) {
  let parts = text.split(":");
  if (parts.length < 3) return null;
  if (parts[parts.length - 1].includes(".")) {
    const tail = v4(parts[parts.length - 1]);
    if (tail === null) return null;
    parts = parts.slice(0, -1).concat([(tail >>> 16).toString(16), (tail & 0xffff).toString(16)]);
  }
  if (parts.length > 9) return null;
  let skip = null;
  for (let i = 1; i < parts.length - 1; i++) {
    if (parts[i] === "") {
      if (skip !== null) return null;
      skip = i;
    }
  }
  let hi;
  let lo;
  let skipped;
  if (skip !== null) {
    hi = skip;
    lo = parts.length - skip - 1;
    if (parts[0] === "") {
      hi -= 1;
      if (hi) return null;
    }
    if (parts[parts.length - 1] === "") {
      lo -= 1;
      if (lo) return null;
    }
    skipped = 8 - (hi + lo);
    if (skipped < 1) return null;
  } else {
    if (parts.length !== 8 || parts[0] === "" || parts[parts.length - 1] === "") return null;
    hi = parts.length;
    lo = 0;
    skipped = 0;
  }
  const groups = [];
  for (let i = 0; i < hi; i++) {
    if (!HEXTET.test(parts[i])) return null;
    groups.push(parseInt(parts[i], 16));
  }
  for (let i = 0; i < skipped; i++) groups.push(0);
  for (let i = parts.length - lo; i < parts.length; i++) {
    if (!HEXTET.test(parts[i])) return null;
    groups.push(parseInt(parts[i], 16));
  }
  return groups.length === 8 ? groups : null;
}

// Global unicast (2000::/3) outside the blocks the registries reserve inside it.
function v6Public(g) {
  if (g[0] >> 13 !== 1) return false;
  if (g[0] === 0x2001 && g[1] >> 9 === 0) return false;
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false;
  if (g[0] === 0x2002) return false;
  if (g[0] === 0x3fff && g[1] >> 12 === 0) return false;
  return true;
}

const TUNNEL_SUFFIXES = [
  ...["ngrok", "ngrok-free"].flatMap((name) => ["io", "app", "dev"].map((tld) => `${name}.${tld}`)),
  "trycloudflare.com",
  "loca.lt",
];
const MAX_HOST = 253;
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;
const ASCII_ONLY = /^[\x00-\x7f]*$/;

// What the URL splitter does with a netloc that holds a bracket, as far as it can refuse the whole URL: a bracketed
// host has to be an IPv6 address (or an IPvFuture form), and nothing may stand before the bracket.
function bracketedNetlocOk(netloc) {
  const hostAndPort = netloc.slice(netloc.lastIndexOf("@") + 1);
  const open = hostAndPort.indexOf("[");
  let hostname;
  if (open !== -1) {
    if (open > 0) return false;
    const rest = hostAndPort.slice(open + 1);
    const close = rest.indexOf("]");
    hostname = close === -1 ? rest : rest.slice(0, close);
    const port = close === -1 ? "" : rest.slice(close + 1);
    if (port && port[0] !== ":") return false;
  } else {
    const colon = hostAndPort.indexOf(":");
    hostname = colon === -1 ? hostAndPort : hostAndPort.slice(0, colon);
  }
  if (hostname[0] === "v" || hostname[0] === "V") return /^[vV][a-fA-F0-9]+\..+$/s.test(hostname);
  const at = hostname.indexOf("%");
  const bare = at === -1 ? hostname : hostname.slice(0, at);
  if (at !== -1 && (at === hostname.length - 1 || hostname.indexOf("%", at + 1) !== -1)) return false;
  return v6(bare) !== null;
}

// ["public_ip" | "tunnel", host] when the base URL's host is one of those, else null.
export function hostKind(url) {
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f || c === 0x5c) return null;
  }
  const m = SCHEME.exec(url);
  if (m === null) return null;
  const scheme = m[1].toLowerCase();
  if (scheme !== "http" && scheme !== "https") return null;
  const rest = url.slice(m[0].length);
  if (rest.slice(0, 2) !== "//") return null;
  let end = rest.length;
  for (const d of "/?#") {
    const at = rest.indexOf(d, 2);
    if (at !== -1 && at < end) end = at;
  }
  const netloc = rest.slice(2, end);
  const open = netloc.includes("[");
  const shut = netloc.includes("]");
  if (open !== shut) return null;
  if (open && !bracketedNetlocOk(netloc)) return null;
  if (!ASCII_ONLY.test(netloc)) return null;
  const authority = netloc.slice(netloc.lastIndexOf("@") + 1);
  if (authority.startsWith("[")) {
    const inner = authority.slice(1);
    const close = inner.indexOf("]");
    if (close === -1) return null;
    const host = inner.slice(0, close);
    const tail = inner.slice(close + 1);
    if ((tail && tail[0] !== ":") || !isPort(tail.slice(1))) return null;
    if (!host || host.length > MAX_HOST || host.includes("%")) return null;
    const groups = v6(host);
    if (groups === null || !v6Public(groups)) return null;
    return ["public_ip", host];
  }
  const colon = authority.indexOf(":");
  let host = colon === -1 ? authority : authority.slice(0, colon);
  const port = colon === -1 ? "" : authority.slice(colon + 1);
  if (!host || host.length > MAX_HOST || !isPort(port)) return null;
  host = host.toLowerCase();
  const address = v4(host);
  if (address !== null) return v4NotPublic(address) ? null : ["public_ip", host];
  const name = host.endsWith(".") ? host.slice(0, -1) : host;
  for (const suffix of TUNNEL_SUFFIXES) {
    if (name === suffix || name.endsWith("." + suffix)) return ["tunnel", name];
  }
  return null;
}

// ----------------------------------------------------------------------------------------------- GLS-STRUCT-004

const ALLOWS_THE_WHOLE_SHELL = new Set(["Bash", "Bash(*)", "Bash(:*)", "*"]);

// The text as one JSON object, else null.
function settingsDocument(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    return null;
  }
  return isObject(document) ? document : null;
}

const SettingsWithoutPrompts = {
  id: "GLS-STRUCT-004",
  name: "Claude Code settings that remove the safety prompts",
  category: "agent_workflow_security",
  severity: "low",
  channel: ["file", "tool_output"],
  description:
    "A Claude Code settings file that switches the permission prompts off, allows every " +
    "shell command, or sends the API traffic to a public IP address or a tunnel host. " +
    "The file's owner can write the same lines, so this is a notice to look at, " +
    "not a verdict.",

  pregate(text) {
    // One JSON object and nothing around it; a key may be spelled with \u escapes, so the key names are tested
    // only when there are none.
    let body = text.trim();
    if (body.charCodeAt(0) === 0xfeff) body = body.slice(1).trimStart();
    if (body[0] !== "{" || body[body.length - 1] !== "}") return false;
    return body.includes("\\u") || ["permissions", "skipDangerousModePermissionPrompt", "ANTHROPIC_BASE_URL"].some((k) => body.includes(k));
  },

  run(text) {
    const document = settingsDocument(text);
    if (document === null) return [];
    const out = [];
    const permissions = own(document, "permissions");
    if (isObject(permissions) && own(permissions, "defaultMode") === "bypassPermissions") {
      out.push(finding(this, "defaultMode: bypassPermissions", { shape: "default_mode" }));
    }
    if (own(document, "skipDangerousModePermissionPrompt") === true) {
      out.push(finding(this, "skipDangerousModePermissionPrompt: true", { shape: "skip_prompt" }));
    }
    if (isObject(permissions) && Array.isArray(own(permissions, "allow"))) {
      const rule = permissions.allow.find((item) => typeof item === "string" && ALLOWS_THE_WHOLE_SHELL.has(item));
      if (rule !== undefined) out.push(finding(this, "allow: " + rule, { shape: "allow_every_shell" }));
    }
    const env = own(document, "env");
    if (isObject(env) && typeof own(env, "ANTHROPIC_BASE_URL") === "string") {
      const judged = hostKind(env.ANTHROPIC_BASE_URL);
      if (judged !== null) {
        out.push(finding(this, "ANTHROPIC_BASE_URL: " + judged[1], { shape: "base_url", host_kind: judged[0] }));
      }
    }
    return out;
  },
};

// ------------------------------------------------------------------------------------------------------ running

export const VALIDATORS = [HookFetchAndRun, SettingsWithoutPrompts, RegistryRedirectInShell];

// The findings of every validator that reads one of the channels. A validator that throws does not take the scan
// down: the findings already made stand.
export function runValidators(text, channels) {
  const out = [];
  for (const validator of VALIDATORS) {
    if (!validator.channel.some((c) => channels.includes(c))) continue;
    try {
      if (validator.pregate(text)) out.push(...validator.run(text));
    } catch {
      // the check is skipped
    }
  }
  return out;
}
