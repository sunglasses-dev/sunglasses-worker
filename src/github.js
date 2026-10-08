// GitHub scan mode — fetches ONLY from raw.githubusercontent.com (hard
// whitelist: no arbitrary URLs, no redirects followed → no SSRF/proxy abuse).
// We scan AGENT-INPUT SURFACES (what an AI agent would read), not source code:
// Sunglasses is an agent-input scanner, not a code auditor.

const RAW_HOST = "raw.githubusercontent.com";
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/; // owner + repo segments
const MAX_FILE_BYTES = 100_000;
const MAX_FILES = 15;

// Files agents actually ingest, tried against the repo's default branch (HEAD).
// Raw paths are case-sensitive — readme casing varies in the wild (tj/commander.js
// ships Readme.md), so the common variants are tried explicitly.
export const AGENT_SURFACES = [
  "README.md",
  "Readme.md",
  "readme.md",
  "CLAUDE.md",
  "AGENTS.md",
  "GEMINI.md",
  ".cursorrules",
  ".clinerules",
  ".windsurfrules",
  ".github/copilot-instructions.md",
  "mcp.json",
  ".mcp.json",
  ".vscode/mcp.json",
  "llms.txt",
];

// Accepts:
//   https://github.com/{owner}/{repo}                     → repo mode (agent surfaces)
//   https://github.com/{owner}/{repo}/blob/{ref}/{path}   → single file
//   https://raw.githubusercontent.com/{owner}/{repo}/...  → single file
// Returns { owner, repo, files: [{path, rawUrl}] } or { error }.
export function parseGitHubUrl(input) {
  if (typeof input !== "string") return { error: "Not a valid URL." };
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return { error: "Not a valid URL." };
  }
  if (url.protocol !== "https:") return { error: "Only https:// GitHub URLs are supported." };

  const parts = url.pathname.split("/").filter(Boolean);

  if (url.hostname === RAW_HOST) {
    if (parts.length < 4) return { error: "Raw URL must be /{owner}/{repo}/{ref}/{path}." };
    const [owner, repo] = parts;
    if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) return { error: "Invalid owner/repo." };
    return {
      owner, repo,
      files: [{ path: parts.slice(3).join("/"), rawUrl: `https://${RAW_HOST}${url.pathname}` }],
    };
  }

  if (url.hostname === "github.com" || url.hostname === "www.github.com") {
    if (parts.length < 2) return { error: "GitHub URL must include owner and repo." };
    const [owner, repo] = parts;
    if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) return { error: "Invalid owner/repo." };
    const cleanRepo = repo.replace(/\.git$/, "");

    if (parts.length === 2) {
      return {
        owner, repo: cleanRepo,
        files: AGENT_SURFACES.map((p) => ({
          path: p,
          rawUrl: `https://${RAW_HOST}/${owner}/${cleanRepo}/HEAD/${p}`,
        })),
      };
    }
    if (parts[2] === "blob" && parts.length >= 5) {
      const refAndPath = parts.slice(3).join("/");
      return {
        owner, repo: cleanRepo,
        files: [{ path: parts.slice(4).join("/"), rawUrl: `https://${RAW_HOST}/${owner}/${cleanRepo}/${refAndPath}` }],
      };
    }
    return { error: "Use a repo URL (github.com/owner/repo) or a file URL (…/blob/branch/file)." };
  }

  return { error: "Only github.com and raw.githubusercontent.com URLs are supported. Website mode is coming later." };
}

// Fetch one whitelisted raw file. Never follows redirects; caps size.
// Reads a reply chunk by chunk and cancels it the moment the cap is passed, so a
// reply with no content-length cannot make the worker hold the whole body.
export async function readCapped(res, limit) {
  if (!res.body) {
    const text = await res.text();
    return new TextEncoder().encode(text).length > limit ? { tooBig: true } : { text };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      reader.cancel().catch(() => {}); // start the cancel, do not wait on a stalled upstream
      return { tooBig: true };
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return { text: new TextDecoder().decode(all) };
}

export async function fetchRawFile(rawUrl) {
  const res = await fetch(rawUrl, { redirect: "manual" });
  if (res.status === 404) return { status: 404 };
  if (res.status !== 200) return { status: res.status, error: `GitHub returned ${res.status}` };

  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_FILE_BYTES) return { status: 413, error: `File exceeds ${MAX_FILE_BYTES / 1000}KB demo cap` };

  const read = await readCapped(res, MAX_FILE_BYTES);
  if (read.tooBig) return { status: 413, error: `File exceeds ${MAX_FILE_BYTES / 1000}KB demo cap` };
  const text = read.text;
  return { status: 200, text };
}

export const GITHUB_CAPS = { MAX_FILE_BYTES, MAX_FILES };
