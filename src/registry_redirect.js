// GLS-STRUCT-006: a shell script points a package manager at a registry that is not public. Port of the pip
// scanner's RegistryRedirectInShell and the script reader under it (validators.py).
//
// The reader follows a script the way a shell would, as far as words go: variables the script sets, here-documents,
// `$(...)` and backtick commands, shells started with `-c` or fed on standard input, wrapper programs, `printf` and
// `echo` text written to a package manager's config file, and the config-set commands of npm, pnpm, yarn and pip.
import {
  PY_ISDIGIT, PY_SPACE, bisectLeft, bisectRight, charSize, cpHead, cpLength, isAscii, pyDigitsToInt, pyFirstWord, pyFloatOk,
  pyIntOk, pyLstrip, pySplitlines, pyStrip, pyUnquote, utf8Size,
} from "./py_text.js";
import {
  ASSIGN, DOLLAR, FENCE_OPEN, FENCE_SHUT, KEYWORDS, PYTHON, SHELLS, Syntax, TooBig, balanced, base, lexScript, program,
  redirectParts, runShell, segments, stdinRedirect, stdoutRedirects, stopped, word as lexWord,
} from "./shell_lexer.js";

const MAX_NESTED = 22; // scripts read inside the one being read: $(...), sh -c strings, heredoc-fed shells
const MAX_NESTING = 3;
const MAX_VALUE = 1 << 16; // the most (UTF-8 bytes) one expansion, or one command's printed text, may hold
const WORK_BUDGET = 1 << 26; // the most (UTF-8 bytes) all expansions of one scan may bring in together
const UNKNOWN = "\x01"; // stands for a value the script does not let us read (command output, unset variable)
const MAX_DESCRIPTOR_DIGITS = 4;

const SHELL_TAG = /^(?:sh|bash|shell|zsh|console|dockerfile)(?![\p{L}\p{N}_+-])/iu;
const PROMPT = /(?<![^\n])([ \t]*)\$ /g;
const VARIABLE_SOURCE = "\\$(?:([A-Za-z_][A-Za-z0-9_]*)|\\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-=+?])([^}]*))?\\})";
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const AUTHORITY = /[^/?#\\]*/y;
const LEAD_WORDS = new Set(["RUN", "ONBUILD", "-", "run:"]);

const CONFIG_FILES = new Map([
  [".npmrc", "npm"], [".yarnrc", "yarn"], [".yarnrc.yml", "yarn_berry"], ["pip.conf", "pip"], ["pip.ini", "pip"],
  [".pypirc", "pypirc"],
]);
const FILE_MANAGER = new Map([["yarn_berry", "yarn"], ["pypirc", "pip"]]);
const PUBLIC_HOSTS = new Set([
  "registry.npmjs.org", "registry.yarnpkg.com", "npm.pkg.github.com", "pypi.org", "files.pythonhosted.org", "pypi.python.org",
]);
const PUBLIC_UPLOAD_HOSTS = new Set(["upload.pypi.org", "test.pypi.org"]);
const DOCUMENTATION_HOSTS = ["example.com", "example.org", "example.net"];
const MANAGERS = new Map([["npm", "npm"], ["pnpm", "pnpm"], ["yarn", "yarn"], ["pip", "pip"], ["pip3", "pip"]]);
const PIP_NAME = /^pip3(?:\.\p{Nd}+)?$/u;
const MANAGER_VALUE_OPTIONS = new Set([
  "--prefix", "--userconfig", "--globalconfig", "--workspace", "-w", "--cache", "--loglevel", "--location", "--registry",
  "--scope", "--otp", "--tag", "--dir", "-C", "--filter", "-F", "--file", "--config", "--cwd", "--cafile", "--ca", "--proxy",
  "--https-proxy", "--before", "--mutex",
]);
// The long options of `pip` (before its command) and of `pip config` (after it): name -> whether it takes a value.
const PIP_GENERAL = new Map(Object.entries({
  "--help": false, "--debug": false, "--isolated": false, "--require-virtualenv": false, "--require-venv": false,
  "--python": true, "--verbose": false, "--version": false, "--quiet": false, "--log": true, "--log-file": true,
  "--local-log": true, "--no-input": false, "--keyring-provider": true, "--proxy": true, "--no-proxy-env": false,
  "--retries": true, "--timeout": true, "--default-timeout": true, "--exists-action": true, "--trusted-host": true,
  "--cert": true, "--client-cert": true, "--cache-dir": true, "--no-cache-dir": false,
  "--disable-pip-version-check": false, "--no-color": false, "--no-python-version-warning": false,
  "--use-feature": true, "--use-deprecated": true, "--resume-retries": true,
}));
// The options whose value pip checks (an int, a float, or one of a list); every other value is any word.
const PIP_CHECKED = new Map(Object.entries({
  "--retries": "int", "--resume-retries": "int", "--timeout": "float", "--default-timeout": "float",
  "--exists-action": ["s", "i", "w", "b", "a"], "--keyring-provider": ["auto", "disabled", "import", "subprocess"],
  "--use-deprecated": ["legacy-resolver", "legacy-certs"],
  "--use-feature": ["fast-deps", "inprocess-build-deps", "venv-isolation", "truststore", "no-binary-enable-wheel-cache", "build-constraint"],
}));

// Whether pip's option parser takes `value` for `name`: a number the way optparse reads one, or a choice.
function pipValueOk(name, value) {
  const kind = PIP_CHECKED.get(name);
  if (kind === undefined || value.includes(UNKNOWN)) return true;
  if (kind === "float") return pyFloatOk(value);
  if (kind === "int") {
    const low = value.slice(0, 2).toLowerCase();
    if (low === "0x") return pyIntOk(value, 16);
    if (low === "0b") return pyIntOk(value.slice(2) || "0", 2);
    return pyIntOk(value, value.slice(0, 1) === "0" ? 8 : 10);
  }
  return kind.includes(value);
}

const PIP_CONFIG = new Map([...PIP_GENERAL, ["--editor", true], ["--global", false], ["--user", false], ["--site", false]]);
const PIP_SHORT = new Set("hvVq"); // -h -v -V -q, which can be written together (-vq)
const NOT_SPACE = `[^${PY_SPACE}`; // class prefix: `${NOT_SPACE}:]` is "not white space and not a colon"
const NPM_KEY = new RegExp(`^(?:registry|@${NOT_SPACE}:]+:registry)$`);
const YARN_KEY = new RegExp(`^(?:registry|@${NOT_SPACE}:]+:registry|npmRegistryServer|npmScopes\\.[^.${PY_SPACE}]+\\.npmRegistryServer)$`);
const PIP_SECTIONS = ["global", "install", "download", "wheel", "list", "index", "lock"]; // where pip reads index settings
const PIP_KEY = new RegExp(`^(?:${PIP_SECTIONS.join("|")})\\.(?:extra[-_])?index[-_]url$`, "iu");
const S = `[${PY_SPACE}]*`;
const NPMRC_LINE = new RegExp(`^${S}(registry|@[^${PY_SPACE}:=]+:registry)${S}=([^\\n]*)`);
const YARNRC_LINE = new RegExp(`^${S}"?(registry|@[^${PY_SPACE}:"=]+:registry)"?(?:${S}[:=]${S}|[${PY_SPACE}]+)([^\\n]*)`);
const BERRY_LINE = new RegExp(`^${S}["']?npmRegistryServer["']?${S}:([^\\n]*)`);
const PIP_LINE = new RegExp(`^${S}(index[-_]url|extra[-_]index[-_]url)${S}[=:]([^\\n]*)`, "iu");
const PYPIRC_LINE = new RegExp(`^${S}repository${S}[=:]([^\\n]*)`, "iu");
const SECTION = new RegExp(`^${S}\\[([^\\]]*)\\]`);
const PRINTF_TOKEN_SOURCE = "%(-?)(\\p{Nd}*)(?:\\.(\\p{Nd}*))?(.?)|\\\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U|[0-7]{1,3}|.?)";
const HEREDOC_ESCAPE = /\\(\n|\\|\$)/g;
const DESCRIPTOR = /^[0-9]+$/;
const WORD_END = " \t\r\f\v\n;|&<>()";
const BACKTICKS = /`([^`\\]*)`/g;
const CREDENTIALS = new RegExp(`(://)[^/?#${PY_SPACE}'"]*@`, "g");
const PYTHON_FLAGS = new Set("IEsSuBbOqvRPdx");
const CONTINUATION = /\\\n/g;
const MANAGER_WORD = /(?<![a-z0-9_])(?:npm|pnpm|yarn|pip[0-9.]*|python[0-9.]*|\.?npmrc|\.?yarnrc|pypirc)(?![a-z0-9_])/;
const MANAGER_AFTER_SPLIT =
  /(?<![a-z0-9_-])-[iv-]*s(?:-[iv-]*s)*(?:npm|pnpm|yarn|pip[0-9.]*|python[0-9.]*|\.?npmrc|\.?yarnrc|pypirc)(?![a-z0-9_])/;
const MAX_FENCES = 20;
const TERMINAL = Symbol("terminal"); // where standard output goes when it is not a file we read

class Found extends Error {
  constructor(evidence, shown) {
    super("found");
    this.evidence = evidence;
    this.shown = shown;
  }
}
class Unreadable extends Error {}

// ------------------------------------------------------------------------------------------------ sizes and slices

// [text.slice(start, end), its UTF-8 size], or TooBig when it would not fit `room` bytes. No piece larger than what is
// left is ever built: a long range is taken in steps that each fit.
function slice(text, start, end, room, asciiOnly) {
  if (end - start > room) throw new TooBig(); // a character is at least one byte
  if (asciiOnly) return [text.slice(start, end), end - start];
  const parts = [];
  let used = 0;
  let pos = start;
  while (pos < end) {
    const step = Math.min(Math.floor((room - used) / 4), 4096); // this many units fit even at four bytes each
    if (step < 1) {
      const cp = text.codePointAt(pos);
      const size = charSize(cp);
      if (used + size > room) throw new TooBig();
      const width = cp > 0xffff ? 2 : 1;
      parts.push(text.slice(pos, pos + width));
      used += size;
      pos += width;
      continue;
    }
    let stop = Math.min(pos + step, end);
    const last = text.charCodeAt(stop - 1);
    if (last >= 0xd800 && last <= 0xdbff && stop < text.length && (text.charCodeAt(stop) & 0xfc00) === 0xdc00) stop += 1;
    const part = text.slice(pos, stop);
    used += utf8Size(part);
    if (used > room) throw new TooBig();
    parts.push(part);
    pos = stop;
  }
  return [parts.join(""), used];
}

// ------------------------------------------------------------------------------------------------ the variables

class Env {
  constructor(from = null) {
    this.vars = new Map(from === null ? undefined : from.vars);
    this.exported = new Set();
    this.work = [WORK_BUDGET]; // shared by every copy: what the scan may still expand
  }
  get(name) { return this.vars.get(name); }
  has(name) { return this.vars.has(name); }
  set(name, value) { this.vars.set(name, value); }
  snapshot() {
    const copy = new Env(this);
    copy.exported = new Set(this.exported);
    copy.work = this.work;
    return copy;
  }
  restore(saved) {
    this.vars = new Map(saved.vars);
    this.exported = new Set(saved.exported);
  }
  // What a started shell sees: the exported variables, and the command's own assignments.
  child(inline = []) {
    const made = new Env();
    for (const [k, v] of this.vars) if (this.exported.has(k)) made.vars.set(k, v);
    made.exported = new Set(made.vars.keys());
    made.work = this.work;
    for (const [name, value] of inline) {
      made.vars.set(name, value);
      made.exported.add(name);
    }
    return made;
  }
}

const hasText = (value) => value.includes("$") || value.includes("`") || value.includes(DOLLAR);

// `value` with the variables the script set replaced; what it cannot read becomes UNKNOWN.
function expand(value, env, depth = 0) {
  return expandMarked(value, env, depth, [])[0];
}

// [expand(value, env, depth), where the offsets `marks` of `value` land in it]. A mark inside a variable reference
// lands after the text that reference becomes.
function expandMarked(value, env, depth, marks) {
  if (!hasText(value)) return [value, marks.slice()];
  const work = env.work;
  if (work[0] <= 0) return [UNKNOWN, marks.map(() => 0)]; // the scan has expanded all it will
  let used = 0;

  const grow = (match) => {
    const name = match[1] || match[2];
    const mode = match[3];
    const wordText = match[4];
    const current = env.get(name);
    const assigned = env.has(name);
    if (mode === undefined) return assigned ? current : UNKNOWN;
    const colon = mode.startsWith(":");
    const sign = mode[mode.length - 1];
    const usable = assigned && (current !== "" || !colon);
    if (sign === "+") return usable && depth < 4 ? expand(wordText, env, depth + 1) : "";
    if (usable) return current;
    if (sign === "?") return UNKNOWN;
    const fallback = depth < 4 ? expand(wordText, env, depth + 1) : UNKNOWN;
    if (sign === "=") env.set(name, fallback);
    return fallback;
  };
  const fill = (match) => {
    const piece = grow(match); // a fallback has already charged what it expanded; the piece is charged again
    const cost = utf8Size(piece);
    used += cost;
    if (used > MAX_VALUE || cost > work[0]) throw new TooBig(); // refused before the text is joined
    work[0] -= cost;
    return piece;
  };

  let result;
  let moved;
  try {
    [result, moved] = fillIn(value, marks, fill);
  } catch (error) {
    if (!(error instanceof TooBig)) throw error;
    work[0] = Math.max(work[0] - MAX_VALUE, 0);
    return [UNKNOWN, marks.map(() => 0)]; // a value this large is left unexpanded
  }
  return [result.split("$").join(UNKNOWN).split("`").join(UNKNOWN).split(DOLLAR).join("$"), moved];
}

// [`value` with every variable reference replaced by fill(match), where `marks` land in it].
function fillIn(value, marks, fill) {
  const variable = new RegExp(VARIABLE_SOURCE, "g");
  if (marks.length) {
    const out = [];
    const moved = [];
    let pos = 0;
    let size = 0;
    let at = 0;
    const count = marks.length;
    for (const found of value.matchAll(variable)) {
      const start = found.index;
      const end = start + found[0].length;
      while (at < count && marks[at] < start) {
        moved.push(size + marks[at] - pos);
        at += 1;
      }
      out.push(value.slice(pos, start));
      size += start - pos;
      out.push(fill(found));
      size += out[out.length - 1].length;
      pos = end;
      while (at < count && marks[at] < (marks[at] % 1 === 0 ? end : end - 0.5)) {
        moved.push(size - 0.5); // a break inside a reference lands after the text it became
        at += 1;
      }
    }
    while (at < count) {
      moved.push(size + marks[at] - pos);
      at += 1;
    }
    out.push(value.slice(pos));
    return [out.join(""), moved];
  }
  return [value.replace(variable, (...args) => fill(args)), []];
}

// ------------------------------------------------------------------------------------------------ registry hosts

// [host, quiet] of a `scheme://authority/...` value, or null when it is not a readable URL. The authority runs to the
// first `/ ? # \`; user-info is everything up to the last `@` in it. A host is quiet when it is exactly one of `pub`
// (after one `www.`), or a name under a reserved documentation domain; never by its prefix.
function registryHost(url, pub = PUBLIC_HOSTS) {
  const scheme = SCHEME.exec(url);
  if (scheme === null) return null;
  AUTHORITY.lastIndex = scheme[0].length;
  const authority = AUTHORITY.exec(url)[0];
  if (authority.includes(UNKNOWN) || authority.includes("$")) return null;
  const hostport = authority.slice(authority.lastIndexOf("@") + 1);
  let host;
  if (hostport.startsWith("[")) {
    host = hostport.includes("]") ? hostport.slice(0, hostport.indexOf("]") + 1) : hostport;
  } else {
    const colon = hostport.lastIndexOf(":");
    const head = colon < 0 ? "" : hostport.slice(0, colon);
    const port = colon < 0 ? "" : hostport.slice(colon + 1);
    host = colon >= 0 && (PY_ISDIGIT.test(port) || !port) ? head : hostport;
  }
  host = pyUnquote(host).toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  const bare = host.startsWith("www.") ? host.slice(4) : host;
  const documented =
    DOCUMENTATION_HOSTS.some((d) => host.endsWith(d)) &&
    (DOCUMENTATION_HOSTS.includes(host) || DOCUMENTATION_HOSTS.some((d) => host.endsWith("." + d)));
  return [host, pub.has(host) || pub.has(bare) || documented];
}

function settingValue(raw) {
  raw = pyStrip(raw);
  const first = raw.slice(0, 1);
  if (first === "'" || first === '"') {
    const end = raw.indexOf(first, 1);
    return end > 0 ? raw.slice(1, end) : raw.slice(1);
  }
  return raw ? pyFirstWord(raw) : "";
}

// [key, value] of each registry setting in `content`, read as the config file `kind`. A pip config file keeps its index
// settings in `[global]` or the section of a command that takes an index, and a `.pypirc` keeps its `repository` in the
// section of one index server (not `[distutils]`).
function fileSettings(kind, content) {
  const out = [];
  let follows = false;
  let section = null;
  for (const line of content.split("\n")) {
    const stripped = pyStrip(line);
    if (!stripped || "#;".includes(stripped[0])) continue;
    const header = SECTION.exec(line);
    if (header !== null && (kind === "pip" || kind === "pypirc")) {
      section = pyStrip(header[1]).toLowerCase();
      follows = false;
      continue;
    }
    let found;
    if (kind === "npm") {
      found = NPMRC_LINE.exec(line);
      if (found !== null) out.push([found[1], settingValue(found[2])]);
    } else if (kind === "yarn") {
      found = YARNRC_LINE.exec(line);
      if (found !== null) out.push([found[1], settingValue(found[2])]);
    } else if (kind === "yarn_berry") {
      found = BERRY_LINE.exec(line);
      if (found !== null) out.push(["npmRegistryServer", settingValue(found[1])]);
    } else if (kind === "pip") {
      found = PIP_SECTIONS.includes(section) ? PIP_LINE.exec(line) : null;
      if (found !== null) {
        follows = true;
        out.push([found[1].toLowerCase(), settingValue(found[2])]);
      } else if (follows && (line[0] === " " || line[0] === "\t") && SCHEME.test(stripped)) {
        out.push(["extra-index-url", settingValue(stripped)]);
      } else follows = false;
    } else if (section !== null && section !== "distutils") {
      found = PYPIRC_LINE.exec(line);
      if (found !== null) out.push(["repository", settingValue(found[1])]);
    }
  }
  return out;
}

// The words of a command line past the lead words of a Dockerfile / CI list item.
function leadWords(words) {
  let i = 0;
  while (i < words.length && words[i].kind === "w" && LEAD_WORDS.has(words[i].value)) i += 1;
  if (i && (words[i - 1].value === "RUN" || words[i - 1].value === "ONBUILD")) {
    while (i < words.length && words[i].kind === "w" && words[i].value.startsWith("--")) i += 1;
  }
  return i ? words.slice(i) : words;
}

// [[name, value word] of the leading assignments of a command, whether a command follows them].
function assignments(words) {
  const found = [];
  let i = 0;
  while (i < words.length && words[i].kind === "w") {
    const value = words[i].value;
    if (KEYWORDS.has(value)) i += 1;
    else if (ASSIGN.test(value)) {
      const eq = value.indexOf("=");
      found.push([value.slice(0, eq), value.slice(eq + 1)]);
      i += 1;
    } else break;
  }
  return [found, i < words.length];
}

// ------------------------------------------------------------------------------------------------ escapes, printf

// The backslash escapes a shell reads are not one language: `printf FORMAT` reads `\NNN` and has no `\c`; `printf %b`
// and `echo -e` read `\0NNN` and stop at `\c`; `echo -e` has no `\NNN` for NNN not starting with 0.
const ESCAPE_DIALECTS = {
  format: "\\\\(x[0-9a-fA-F]{1,2}|[uU]|[0-7]{1,3}|.?)",
  operand: "\\\\(c|x[0-9a-fA-F]{1,2}|[uU]|0[0-7]{0,3}|[1-7][0-7]{0,2}|.?)",
  echo: "\\\\(c|x[0-9a-fA-F]{1,2}|[uU]|0[0-7]{0,3}|.?)",
};
const ESCAPES = new Map([["n", "\n"], ["t", "\t"], ["\\", "\\"], ["r", "\r"], ["a", "\x07"], ["b", "\b"], ["f", "\f"], ["v", "\v"]]);
const FORMAT_ONLY = new Map([["'", "'"], ['"', '"'], ["?", "?"]]);

// The text of the escape `\<code>`, or null when it stops the output (`\c`).
function escaped(code, dialect) {
  if (code === "c") return dialect === "format" ? "\\c" : null;
  if ((code.slice(0, 1) === "u" || code.slice(0, 1) === "U") || code === "x") throw new Unreadable();
  if (code[0] === "x" && code.length > 1) return String.fromCharCode(parseInt(code.slice(1), 16));
  if (code && "01234567".includes(code[0]) && (code[0] === "0" || dialect !== "echo")) {
    return String.fromCharCode(parseInt(code, 8) & 255);
  }
  if (ESCAPES.has(code)) return ESCAPES.get(code);
  if ((code === "e" || code === "E") && dialect !== "echo") return "\x1b";
  if (dialect === "format" && FORMAT_ONLY.has(code)) return FORMAT_ONLY.get(code);
  return "\\" + code;
}

// [text with its backslash escapes read in `dialect`, whether a `\c` ended the output]. With a `room` (UTF-8 bytes) it
// throws TooBig before it builds a piece that would pass it.
function unescape(text, dialect, room = null) {
  const out = [];
  let pos = 0;
  let left = room;
  const plain = isAscii(text);
  const pattern = new RegExp(ESCAPE_DIALECTS[dialect], "gsu");
  for (const m of text.matchAll(pattern)) {
    let between;
    if (left === null) between = text.slice(pos, m.index);
    else {
      let size;
      [between, size] = slice(text, pos, m.index, left, plain);
      left -= size;
    }
    pos = m.index + m[0].length;
    const piece = escaped(m[1], dialect);
    if (piece !== null && left !== null) {
      left -= utf8Size(piece);
      if (left < 0) throw new TooBig();
    }
    out.push(between);
    if (piece === null) return [out.join(""), true];
    out.push(piece);
  }
  if (left === null) out.push(text.slice(pos));
  else out.push(slice(text, pos, text.length, left, plain)[0]);
  return [out.join(""), false];
}

// What `printf FORMAT ARGS` writes for a format of `%s`, `%b` and `%%` (with `-`, a width and a precision), or null for
// any other conversion, whose output is left alone here.
function printf(fmt, args) {
  const tokens = [...fmt.matchAll(new RegExp(PRINTF_TOKEN_SOURCE, "gsu"))];
  const specs = tokens.filter((m) => m[1] !== undefined);
  for (const m of specs) {
    const kind = m[4];
    const width = m[2];
    const precision = m[3];
    if (kind !== "s" && kind !== "b" && kind !== "%") return null;
    if (cpLength(width) > 4 || cpLength(precision || "") > 4) return null;
    if (kind === "%" && (m[1] || width || precision !== undefined)) return null;
    if (cpLength(width) > 1 && width[0] === "0") return null; // a zero flag pads with zeros
  }
  const slots = specs.filter((m) => m[4] !== "%").length;
  const room = [MAX_VALUE];
  const plain = isAscii(fmt);
  const need = (size) => {
    if (size > room[0]) throw new TooBig(); // the text it would write is too large to read
  };
  const put = (out, piece) => {
    need(utf8Size(piece));
    room[0] -= utf8Size(piece);
    out.push(piece);
  };
  const putRange = (out, start, end) => {
    const [piece, size] = slice(fmt, start, end, room[0], plain);
    room[0] -= size;
    out.push(piece);
  };
  const render = (chunk) => {
    let taken = 0;
    const out = [];
    let pos = 0;
    for (const m of tokens) {
      putRange(out, pos, m.index);
      pos = m.index + m[0].length;
      if (m[1] === undefined) {
        put(out, escaped(m[5], "format"));
        continue;
      }
      const kind = m[4];
      if (kind === "%") {
        put(out, "%");
        continue;
      }
      let value = taken < chunk.length ? chunk[taken] : "";
      taken += 1;
      let stopped2 = false;
      if (kind === "b") [value, stopped2] = unescape(value, "operand", room[0]);
      if (m[3] !== undefined) {
        const keep = Math.min(pyDigitsToInt(m[3] || ""), cpLength(value));
        value = slice(value, 0, cpHead(value, keep).length, room[0], isAscii(value))[0]; // taken only if it fits
      }
      const width = pyDigitsToInt(m[2] || "");
      const padding = Math.max(width - cpLength(value), 0);
      need(utf8Size(value) + padding); // the padding is decided before it is built
      put(out, m[1] ? value + " ".repeat(padding) : " ".repeat(padding) + value);
      if (stopped2) return [out.join(""), true];
    }
    putRange(out, pos, fmt.length);
    return [out.join(""), false];
  };
  if (!slots) return render([])[0];
  const written = [];
  for (let first = 0; first < Math.max(args.length, 1); first += slots) {
    const [text, stoppedOut] = render(args.slice(first, first + slots));
    written.push(text);
    if (stoppedOut) break;
  }
  return written.join("");
}

// [an unquoted here-document's backslash escapes read, its line breaks or null]: a joined line end is a break half an
// offset before the text that followed it, so every later token keeps its physical line.
function heredocUnescape(body) {
  const out = [];
  const shifts = [];
  let pos = 0;
  let size = 0;
  for (const m of body.matchAll(HEREDOC_ESCAPE)) {
    out.push(body.slice(pos, m.index));
    size += m.index - pos;
    pos = m.index + m[0].length;
    if (m[1] === "\n") shifts.push(size);
    else {
      out.push(m[1] === "\\" ? "\\" : DOLLAR);
      size += 1;
    }
  }
  out.push(body.slice(pos));
  const text = out.join("");
  if (!shifts.length) return [text, null];
  const breaks = [];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) breaks.push(i);
  for (const at of shifts) breaks.push(at - 0.5);
  breaks.sort((a, b) => a - b);
  return [text, breaks];
}

// Whether the word that starts at offset `at` of `text` ends in a `-` the shell sees as its last character: written
// bare or escaped (`3\-`), with line continuations joined. A dash that closes a quote or comes from a variable is not
// written there.
function bareDash(text, at) {
  let quote = null;
  let dash = false;
  let i = at;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") quote = null;
    } else if (quote === '"') {
      if (c === "\\") i += 1;
      else if (c === '"') quote = null;
    } else if (WORD_END.includes(c)) break;
    else if (c === "\\") {
      if (text.startsWith("\n", i + 1)) i += 1; // a continuation joins the lines and is not part of the word
      else {
        dash = text.startsWith("-", i + 1); // an escaped dash is still the last character the shell sees
        i += 1;
      }
    } else if (c === "'" || c === '"') {
      quote = c;
      dash = false;
    } else dash = c === "-";
    i += 1;
  }
  return dash && quote === null;
}

// The bodies of the fenced blocks whose tag matches `wanted`; one pass over the lines. `starts`, when given, receives
// the 1-based line of each body's first line.
function fencedBlocks(text, wanted, starts = null) {
  const blocks = [];
  let body = null;
  let fence = null;
  let other = null; // the marker of an open fence that is not the wanted one: what it holds is not a block
  let number = 0;
  for (const line of pySplitlines(text)) {
    number += 1;
    if (other !== null) {
      const shut = FENCE_SHUT.exec(line);
      if (shut !== null && shut[1][0] === other[0] && shut[1].length >= other.length) other = null;
      continue;
    }
    if (body === null) {
      const opened = FENCE_OPEN.exec(line);
      if (opened !== null) {
        if (wanted.test(opened[2])) {
          fence = opened[1];
          body = [];
          if (starts !== null) starts.push(number + 1);
        } else other = opened[1];
      }
      continue;
    }
    const shut = FENCE_SHUT.exec(line);
    if (shut !== null && shut[1][0] === fence[0] && shut[1].length >= fence.length) {
      blocks.push(body.join("\n"));
      body = null;
      if (blocks.length >= MAX_FENCES) break;
    } else body.push(line);
  }
  if (body !== null && blocks.length < MAX_FENCES) blocks.push(body.join("\n")); // a fence left open runs to the end
  return blocks;
}

// ------------------------------------------------------------------------------------------------ the reader

class ShellReader {
  constructor() {
    this.nested = MAX_NESTED;
    this.work = [WORK_BUDGET]; // what the whole scan may still expand, whichever way the text is read
    this.newlines = new Map(); // text -> offsets of its newlines: a line number is a bisect, not a count
    this.breaks = new Map(); // text -> offsets where a physical line ends, for text made from a here-document
  }

  // Read `text` as one script; throws Found at the first redirect to a non-public registry.
  read(text, line = 1, depth = 0, env = null, fences = null) {
    if (env === null) {
      env = new Env();
      env.work = this.work;
    }
    let previous = null;
    const scopes = [];
    for (const seg of segments(lexScript(text, 0, false, fences))) {
      for (let k = 0; k < seg.opens; k++) scopes.push(env.snapshot()); // a ( ... ) group is a subshell
      const piped = seg.sepBefore === "|" || seg.sepAfter === "|" || seg.sepBefore === "|&" || seg.sepAfter === "|&";
      const staged = piped ? env.snapshot() : null;
      previous = this.segment(seg, previous, text, line, depth, env);
      if (staged !== null) env.restore(staged); // what a pipeline stage sets is gone with its shell
      for (let k = 0; k < seg.closes; k++) {
        if (scopes.length) env.restore(scopes.pop());
        previous = null;
      }
    }
  }

  // Read one command; returns the text it leaves on the pipe, or null.
  segment(seg, previous, text, line, depth, env) {
    if (seg.sepBefore !== "|" && seg.sepBefore !== "|&") previous = null;
    const words = leadWords(seg.words);
    const toks = words.concat(seg.redirs.filter(([, t]) => t !== null).map(([, t]) => t));
    for (const tok of toks) {
      const pairs = tok.kind === "w" ? tok.subs.map((body, k) => [body, tok.subAt[k]]) : [[tok.value, 2]];
      for (const [body, inside] of pairs) this.nestedRead(text, tok.at + inside, body, line, depth, env.snapshot(), true);
    }
    const [assigned, hasCommand] = assignments(words);
    const inline = assigned.map(([name, value]) => [name, expand(value, env)]);
    if (!hasCommand) {
      for (const [name, value] of inline) env.set(name, value);
      return null;
    }
    const found = program(words);
    if (found === null) return null;
    const [wordTok, args] = found;
    const name = base(wordTok.value);
    const [stdin, stdinLine] = this.stdin(seg, previous, env, text, line, depth);
    if (["export", "declare", "local", "readonly", "typeset"].includes(name)) {
      const flags = args.filter((a) => a.kind === "w" && a.value.length > 1 && "-+".includes(a.value[0])).map((a) => a.value);
      const unexports =
        flags.some((f) => f.startsWith("+") && f.includes("x")) ||
        (name === "export" && flags.some((f) => f.startsWith("-") && f.includes("n")));
      const exports = !unexports && (name === "export" || flags.some((f) => f.startsWith("-") && f.includes("x")));
      for (const arg of args) {
        if (arg.kind !== "w" || arg.value.startsWith("-")) continue;
        const eq = arg.value.indexOf("=");
        const key = eq < 0 ? arg.value : arg.value.slice(0, eq);
        if (eq >= 0 && ASSIGN.test(arg.value)) env.set(key, expand(arg.value.slice(eq + 1), env));
        if (exports && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env.exported.add(key);
        else if (unexports) env.exported.delete(key);
      }
    } else if (name === "unset") {
      for (const arg of args) {
        env.vars.delete(arg.value);
        env.exported.delete(arg.value);
      }
    } else if (name === "read" || name === "for") {
      for (const arg of name === "for" ? args.slice(0, 1) : args) {
        if (arg.kind === "w" && !arg.value.startsWith("-") && ASSIGN.test(arg.value + "=")) env.set(arg.value, UNKNOWN);
      }
    } else if (MANAGERS.has(name) || PIP_NAME.test(name) || PYTHON.test(name)) {
      this.manager(name, args, env, wordTok, text, line);
    } else if (SHELLS.has(name)) {
      this.shell(args, stdin, stdinLine, text, line, depth, env, inline);
    } else {
      const shown = this.printed(name, args, stdin, env);
      this.writes(name, seg, args, shown, env, text, line);
      return stdoutRedirects(seg).length ? null : shown;
    }
    return null;
  }

  // The line number of offset `at` in `text`, which starts at line `line`.
  number(text, at, line) {
    const known = this.breaks.get(text);
    if (known !== undefined) return line + bisectLeft(known, at);
    let seen = this.newlines.get(text);
    if (seen === undefined) {
      if (this.newlines.size >= MAX_NESTED + 64) {
        let count = 0;
        for (let i = text.indexOf("\n"); i !== -1 && i < at; i = text.indexOf("\n", i + 1)) count += 1;
        return line + count;
      }
      seen = [];
      for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) seen.push(i);
      this.newlines.set(text, seen);
    }
    return line + bisectLeft(seen, at);
  }

  // Keep where the physical lines of `text`, made from a here-document, end.
  remember(text, breaks) {
    if (breaks !== null && this.breaks.size < MAX_NESTED + 64) this.breaks.set(text, breaks);
  }

  // [line number, the line's text] of offset `at` in `text`, which starts at line `line`.
  lineOf(text, at, line) {
    const start = at === 0 ? 0 : text.lastIndexOf("\n", at - 1) + 1;
    let end = text.indexOf("\n", at);
    end = end < 0 ? text.length : end;
    const shown = cpHead(pyStrip(text.slice(start, end)).replace(CREDENTIALS, "$1***@"), 50);
    return [this.number(text, at, line), shown];
  }

  // Read `body`, a script that starts on line `number`, with the variables `env`.
  into(body, number, depth, env) {
    if (depth >= MAX_NESTING || this.nested <= 0 || !body) return;
    this.nested -= 1;
    this.read(body, number, depth + 1, env);
  }

  // Read the `$(...)` and backtick commands in the text of an unquoted here-document.
  substitutions(body, number, depth, env) {
    let pos = 0;
    while (this.nested > 0) {
      const at = body.indexOf("$(", pos);
      if (at < 0) break;
      if (body.startsWith("((", at + 1)) {
        pos = at + 3;
        continue;
      }
      let end;
      try {
        end = balanced(body, at + 1);
      } catch (error) {
        if (error instanceof Syntax || error instanceof RangeError) break;
        throw error;
      }
      this.sliceRead(body, at + 2, end - 1, number, depth, env);
      pos = end;
    }
    for (const found of body.matchAll(BACKTICKS)) {
      const start = found.index + 1;
      this.sliceRead(body, start, start + found[1].length, number, depth, env);
    }
  }

  // Read `body[start:end]`, a command inside a here-document, with the joined line ends it holds.
  sliceRead(body, start, end, number, depth, env) {
    const piece = body.slice(start, end);
    this.carry(body, piece, start);
    this.into(piece, this.number(body, start, number), depth, env.snapshot());
  }

  // Give `piece`, which sits at offset `start` of `text`, the line breaks `text` has in it.
  carry(text, piece, start) {
    const known = this.breaks.get(text);
    if (known !== undefined) {
      const low = bisectLeft(known, start);
      const high = bisectLeft(known, start + piece.length);
      this.remember(piece, known.slice(low, high).map((x) => x - start));
    }
  }

  // Read `body`, a command inside `text`, with `text`'s line breaks. `at` is where `body` starts when `exact`;
  // otherwise only where the word that holds it starts (its text was changed on the way).
  nestedRead(text, at, body, line, depth, env, exact = false) {
    if (depth >= MAX_NESTING || this.nested <= 0 || !body) return;
    if (exact) this.carry(text, body, at);
    this.into(body, this.number(text, at, line), depth, env);
  }

  // expand(word.value, env) for a word of `text`, and register where its physical lines end.
  value(text, wordTok, env) {
    const trace = [];
    let again;
    let end;
    try {
      [again, end] = lexWord(text, wordTok.at, true, trace);
    } catch (error) {
      if (error instanceof Syntax || error instanceof RangeError) return expand(wordTok.value, env);
      throw error;
    }
    if (again.value !== wordTok.value || trace.length < 2) return expand(wordTok.value, env);
    const known = this.breaks.get(text);
    let inside;
    if (known !== undefined) {
      inside = known.slice(bisectLeft(known, wordTok.at), bisectLeft(known, end));
    } else {
      inside = [];
      for (let i = text.indexOf("\n", wordTok.at); i !== -1 && i < end; i = text.indexOf("\n", i + 1)) inside.push(i);
    }
    const starts = trace.map((t) => t[0]);
    const breaks = [];
    for (const found of inside) {
      const after = found === Math.trunc(found) ? found + 1 : Math.trunc(found + 0.5); // where the next line starts
      let k = Math.min(bisectRight(starts, after) - 1, trace.length - 1);
      if (k < 0) k += trace.length;
      const [source, out, lead] = trace[k];
      const span = k + 1 < trace.length ? trace[k + 1][1] - out : 0;
      const into = after - source - lead;
      // a character the quoting drops lands where the text after it does
      breaks.push(out + (0 <= into && into < span ? into : Math.max(Math.min(into, span), 0)) - 0.5);
    }
    breaks.sort((a, b) => a - b);
    const [shown, shownBreaks] = expandMarked(wordTok.value, env, 0, breaks);
    if (shown !== UNKNOWN) this.remember(shown, shownBreaks);
    return shown;
  }

  // [the text a command reads on standard input, the line it starts on]: its here-document or here-string, else the pipe.
  stdin(seg, previous, env, text, line, depth) {
    const redirect = stdinRedirect(seg);
    for (const [operator, target] of seg.redirs) {
      const op = redirectParts(operator)[1];
      if (
        (op === "<<" || op === "<<-") && target !== null && target.kind === "w" && target.body !== null && target.expand &&
        (redirect === null || target !== redirect[1])
      ) {
        const [body, breaks] = heredocUnescape(target.body); // the shell runs its commands whatever takes it
        this.remember(body, breaks);
        this.substitutions(body, this.number(text, target.bodyAt, line), depth, env);
      }
    }
    if (redirect === null) return [previous, line];
    const [op, target] = redirect;
    if (target === null || target.kind !== "w") return [null, line];
    if ((op === "<<" || op === "<<-") && target.body !== null) {
      const number = this.number(text, target.bodyAt, line);
      if (!target.expand) return [target.body, number];
      const [body, breaks] = heredocUnescape(target.body);
      this.remember(body, breaks);
      this.substitutions(body, number, depth, env);
      const [shown, shownBreaks] = expandJoined(body, breaks, env);
      this.remember(shown, shownBreaks);
      return [shown, number];
    }
    if (op === "<<<") return [this.value(text, target, env), this.number(text, target.at, line)];
    return [null, line];
  }

  // A shell the script starts: it inherits the exported variables and the command's own assignments.
  shell(args, stdin, stdinLine, text, line, depth, env, inline) {
    const run = runShell(args);
    const child = env.child(inline);
    if (run.mode === "inline" && run.inline !== null) {
      this.nestedRead(text, run.inline.at, this.value(text, run.inline, env), line, depth, child);
    } else if (run.mode === "stdin" && stdin) this.into(stdin, stdinLine, depth, child);
  }

  // The text a content command writes to standard output, or null when we cannot know it.
  printed(name, args, stdin, env) {
    const words = args.filter((a) => a.kind === "w");
    if (name === "echo") {
      let i = 0;
      let escapes = false;
      while (i < words.length && /^-[neE]+$/.test(words[i].value)) {
        for (const ch of words[i].value.slice(1)) if (ch === "e" || ch === "E") escapes = ch === "e";
        i += 1;
      }
      let room = MAX_VALUE;
      const expanded = [];
      for (const w of words.slice(i)) {
        expanded.push(expand(w.value, env));
        room -= utf8Size(expanded[expanded.length - 1]) + 1;
        if (room < 0) return null; // the text it would write is too large to read
      }
      const shown = expanded.join(" ");
      try {
        return escapes ? unescape(shown, "echo")[0] : shown;
      } catch (error) {
        if (error instanceof Unreadable) return null;
        throw error;
      }
    }
    if (name === "printf") {
      if (!words.length) return null;
      let values = [];
      let room = 4 * MAX_VALUE;
      for (const w of words) {
        values.push(expand(w.value, env));
        room -= utf8Size(values[values.length - 1]);
        if (room < 0) return null; // operands too large to read
      }
      if (values[0] === "--") values = values.slice(1); // the end of the options: what follows is the format
      else if (values[0].length > 1 && values[0].startsWith("-")) return null; // an option (`-v VAR` stores the text)
      if (!values.length) return null;
      try {
        return printf(values[0], values.slice(1));
      } catch (error) {
        if (error instanceof Unreadable || error instanceof TooBig) return null;
        throw error;
      }
    }
    if (name === "tee") return stdin;
    if (name === "cat") {
      const files = words.filter((w) => !w.value.startsWith("-") || w.value === "-");
      if (files.some((w) => w.value !== "-")) return files.some((w) => w.value === "-") ? stdin : null;
      return stdin;
    }
    return null;
  }

  // A command that writes what it prints to a package-manager config file.
  writes(name, seg, args, shown, env, text, line) {
    if (shown === null) return;
    const targets = [];
    const table = new Map([[0, TERMINAL], [1, TERMINAL], [2, TERMINAL]]); // descriptor -> the file word, TERMINAL, or absent = closed
    for (const [operator, target] of seg.redirs) {
      const [fd, op] = redirectParts(operator);
      if (target === null || target.kind !== "w" || !(fd === "" || /^[0-9]+$/.test(fd))) continue;
      if (fd.length > MAX_DESCRIPTOR_DIGITS) return; // not a descriptor the shell has: the command does not run
      const n = fd ? Number(fd) : op.startsWith("<") ? 0 : 1;
      if ((op === "&>" || op === "&>>") && !fd) {
        table.set(1, target);
        table.set(2, target);
      } else if (op === ">" || op === ">>" || op === ">|" || op === "<>") table.set(n, target);
      else if (op === "<" || op === "<<" || op === "<<-" || op === "<<<") table.set(n, TERMINAL); // opened for reading
      else if (op === ">&" || op === "<&") {
        const value = expand(target.value, env);
        if (value.includes(UNKNOWN)) return; // a word we cannot read: whether the redirect works is unknown
        const move = value.endsWith("-") && DESCRIPTOR.test(value.slice(0, -1)) && bareDash(text, target.at);
        const digits = move ? value.slice(0, -1) : value;
        if (DESCRIPTOR.test(digits)) {
          if (digits.length > MAX_DESCRIPTOR_DIGITS || !table.has(Number(digits))) return; // a closed descriptor
          const source = Number(digits);
          table.set(n, table.get(source));
          if (move && source !== n) table.delete(source);
        } else if (value === "-") table.delete(n);
        else if (op === ">&" && n === 1) {
          table.set(1, target); // `>&file` writes the file; so does `1>&file`
          table.set(2, target);
        } else return; // any other descriptor, or `<&file`: an ambiguous redirect
      }
    }
    const out = table.get(1);
    if (out !== undefined && out !== TERMINAL) targets.push(out);
    if (name === "tee") {
      for (const arg of args) if (arg.kind === "w" && !arg.value.startsWith("-")) targets.push(arg);
    }
    for (const target of targets) {
      const path = expand(target.value, env);
      const kind = CONFIG_FILES.get(path.slice(path.lastIndexOf("/") + 1));
      if (kind === undefined) continue;
      const pub = kind === "pypirc" ? new Set([...PUBLIC_HOSTS, ...PUBLIC_UPLOAD_HOSTS]) : PUBLIC_HOSTS;
      for (const [key, value] of fileSettings(kind, shown)) {
        this.judge("file_write", FILE_MANAGER.get(kind) || kind, key, value, pub, target, text, line);
      }
    }
  }

  // The words of a `pip config ...` command line that are not options, or null when the line is not a command that
  // runs: pip rejects an option it does not have (or an ambiguous prefix, or a value given to a flag), and prints help
  // or its version instead of running one.
  pipWords(args, env) {
    const words = [];
    let longs = PIP_GENERAL;
    let command = false;
    let ended = false;
    let i = 0;
    while (i < args.length && args[i].kind === "w") {
      const tok = args[i];
      i += 1;
      const value = expand(tok.value, env);
      if (!ended && value === "--") ended = true;
      else if (!ended && value.length > 1 && value[0] === "-") {
        if (value.startsWith("--")) {
          const eqAt = value.indexOf("=");
          const name = eqAt < 0 ? value : value.slice(0, eqAt);
          const equals = eqAt >= 0;
          let given = equals ? value.slice(eqAt + 1) : "";
          const found = longs.has(name) ? [name] : [...longs.keys()].filter((k) => k.startsWith(name));
          if (found.length !== 1 || (equals && !longs.get(found[0]))) return null;
          if (found[0] === "--help" || (found[0] === "--version" && !command)) return null;
          if (longs.get(found[0])) {
            if (!equals) {
              if (i >= args.length || args[i].kind !== "w") return null; // the option needs a value and there is none
              given = expand(args[i].value, env);
              i += 1; // the next word is its value, whatever it starts with
            }
            if (!pipValueOk(found[0], given)) return null;
          }
        } else if (![...value.slice(1)].every((ch) => PIP_SHORT.has(ch)) || value.includes("h") || (value.includes("V") && !command)) {
          return null;
        }
      } else {
        words.push([value, tok]);
        if (!command) {
          if (value !== "config") return null;
          command = true;
          longs = PIP_CONFIG;
          ended = false;
        }
      }
    }
    return words;
  }

  // `npm|pnpm|yarn|pip config set <registry key> <value>` (`python -m pip` included).
  manager(name, args, env, wordTok, text, line) {
    if (PYTHON.test(name)) {
      const options = args.filter((a) => a.kind === "w");
      let i = 0;
      while (i < options.length && options[i].value !== "-m") {
        const flag = options[i].value;
        if (flag === "-W" || flag === "-X") i += 2;
        else if (flag.length > 1 && flag[0] === "-" && [...flag.slice(1)].every((ch) => PYTHON_FLAGS.has(ch))) i += 1;
        else return;
      }
      if (i + 1 < options.length && options[i + 1].value === "pip") {
        args = args.slice(args.indexOf(options[i + 1]) + 1);
        name = "pip";
      } else return;
    }
    const manager = MANAGERS.get(name) || "pip";
    let words;
    if (manager === "pip") {
      words = this.pipWords(args, env);
      if (words === null) return;
    } else {
      words = [];
      let i = 0;
      let ended = false;
      while (i < args.length && args[i].kind === "w") {
        const tok = args[i];
        i += 1;
        const value = expand(tok.value, env);
        if (!ended && value === "--") ended = true;
        else if (!ended && value.length > 1 && value[0] === "-") {
          if (value === "--help" || value === "-h") return;
          if (MANAGER_VALUE_OPTIONS.has(value)) i += 1;
        } else words.push([value, tok]);
      }
    }
    const values = words.map(([v]) => v);
    let rest;
    if ((manager === "npm" || manager === "pnpm") && values[0] === "set") rest = values.slice(1);
    else if ((values[0] === "config" || values[0] === "c") && values[1] === "set" && (values[0] === "config" || manager === "npm")) {
      rest = values.slice(2);
    } else return;
    if ((manager === "pip" || manager === "yarn") && rest.length !== 2) return;
    const pairs = [];
    let i = 0;
    while (i < rest.length) {
      let key;
      let value;
      if (rest[i].includes("=") && (manager === "npm" || manager === "pnpm")) {
        const eq = rest[i].indexOf("=");
        key = rest[i].slice(0, eq);
        value = rest[i].slice(eq + 1);
        i += 1;
      } else {
        key = rest[i];
        value = i + 1 < rest.length ? rest[i + 1] : "";
        i += 2;
      }
      pairs.push([key, value]);
    }
    const keys = { npm: NPM_KEY, pnpm: NPM_KEY, yarn: YARN_KEY, pip: PIP_KEY }[manager];
    for (const [key, value] of pairs) {
      if (keys.test(key) && value) this.judge("config_set", manager, key, value, PUBLIC_HOSTS, wordTok, text, line);
    }
  }

  judge(sink, manager, key, value, pub, tok, text, line) {
    const parsed = registryHost(value, pub);
    if (parsed === null || parsed[1]) return;
    const [number, shown] = this.lineOf(text, tok.at, line);
    throw new Found({ sink, manager, key, host: cpHead(parsed[0], 80), line: number }, shown);
  }
}

// [expand(body, env), its line breaks]: `breaks` are the offsets of `body` where a physical line ends (a newline at its
// own offset, a joined line end half an offset before the text that followed it); the newlines a variable's value
// brings are not source lines and are left out.
function expandJoined(body, breaks, env) {
  if (!hasText(body)) return [body, breaks];
  if (breaks === null) {
    breaks = [];
    for (let i = body.indexOf("\n"); i !== -1; i = body.indexOf("\n", i + 1)) breaks.push(i);
  }
  return expandMarked(body, env, 0, breaks);
}

// ------------------------------------------------------------------------------------------------ the validator

export const RegistryRedirectInShell = {
  id: "GLS-STRUCT-006",
  name: "Shell points a package manager at a registry that is not public",
  category: "supply_chain",
  severity: "medium",
  channel: ["file", "code"],
  description:
    "A shell script in this text points a package manager (npm, pnpm, yarn or pip) at a " +
    "registry that is not one of the public ones, with a config-set command or by writing " +
    "its config file, so the installs that use that setting come from that host. A project mirror " +
    "looks the same as a hijack, so this is a finding for judgment, not proof of intent.",

  pregate(text) {
    // a package manager or one of its config files, spelled with its quotes and continuations removed: the shell reads
    // `n'p'm` and `.npm\` + newline + `rc` as those names
    const seen = text.toLowerCase().replace(CONTINUATION, "").split("\\_").join(" ").replace(/['"\\]/g, ""); // env -S reads \_ as a blank
    return MANAGER_WORD.test(seen) || MANAGER_AFTER_SPLIT.test(seen);
  },

  run(text) {
    stopped.atLimit = false;
    const reader = new ShellReader();
    try {
      const fenceAt = [];
      reader.read(text, 1, 0, null, fenceAt);
      const fences = new Set();
      let seen = 0;
      let number = 1;
      for (const at of fenceAt) {
        for (let i = text.indexOf("\n", seen); i !== -1 && i < at; i = text.indexOf("\n", i + 1)) number += 1;
        seen = at;
        fences.add(number);
      }
      const starts = [];
      const env = new Env();
      env.work = reader.work;
      const blocks = fencedBlocks(text, SHELL_TAG, starts);
      for (let k = 0; k < Math.min(blocks.length, starts.length); k++) {
        if (fences.has(starts[k] - 1)) reader.read(blocks[k].replace(PROMPT, "$1"), starts[k], 0, env);
      }
    } catch (error) {
      if (!(error instanceof Found)) throw error;
      return [{
        id: this.id,
        name: this.name,
        category: this.category,
        severity: this.severity,
        channel: [...this.channel],
        description: this.description,
        matched_text: error.shown,
        structural: true,
        evidence: error.evidence,
      }];
    }
    return [];
  },
};
