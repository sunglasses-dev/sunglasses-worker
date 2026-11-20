// GLS-STRUCT-001: a hook command downloads code and hands it to a shell or an interpreter. Port of the pip scanner's
// HookFetchAndRun and classify_command (validators.py).
//
// Membership is read by parsing: the text is parsed as JSON, or the outermost object around every literal "hooks" key is
// found with one linear brace walk and parsed on its own. Under a key named `hooks` every string value of a key named
// `command` is a hook command. Each command is split into words by the shell lexer and then into pipeline segments, and
// the fetched bytes must reach the runner by one of four links: pipe, process substitution, command substitution, or a
// download that a later segment runs.
import { pinRx } from "./pinned.js";
import { PY_ISDIGIT, PY_SPACE, cpHead } from "./py_text.js";
import {
  Syntax, base, lex, program, redirectParts, runShell, Run, segments, startsOneOf, stdinRedirect, stdoutRedirects, stopped,
  SHELLS, PYTHON,
} from "./shell_lexer.js";

const MAX_CANDIDATES = 64;
const MAX_HOOKS_DEPTH = 8;
const MAX_NESTED_COMMANDS = 4;

// ------------------------------------------------------------------------------------------------------ JSON

// The JSON text decoder of the pip scanner's interpreter, which also reads NaN, Infinity and -Infinity. Objects come back
// as Map (in the order the keys first appear, a repeated key keeping its first place and its last value), arrays as
// Array. Returns undefined when the text is not one JSON value. Iterative: a deep text costs a list, not the stack.
const JSON_WS = /[ \t\n\r]*/y;
const JSON_NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?/y;
const JSON_STRING = /"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
const FAIL = Symbol("not json");

function pyJson(text) {
  if (text.charCodeAt(0) === 0xfeff) return undefined;
  let i = 0;
  const n = text.length;
  const ws = () => {
    JSON_WS.lastIndex = i;
    JSON_WS.exec(text);
    i = JSON_WS.lastIndex;
  };
  // One scalar at i, or FAIL; for "[" and "{" the caller opens a container.
  const scalar = () => {
    const c = text[i];
    if (c === '"') {
      JSON_STRING.lastIndex = i;
      const m = JSON_STRING.exec(text);
      if (m === null) return FAIL;
      i = JSON_STRING.lastIndex;
      return JSON.parse(m[0]);
    }
    for (const [word, value] of [["null", null], ["true", true], ["false", false], ["NaN", NaN], ["Infinity", Infinity], ["-Infinity", -Infinity]]) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return value;
      }
    }
    JSON_NUMBER.lastIndex = i;
    const m = JSON_NUMBER.exec(text);
    if (m === null) return FAIL;
    i = JSON_NUMBER.lastIndex;
    return Number(m[0]);
  };
  const stack = []; // open containers: { value, key } for an object waiting on a value, else an array
  ws();
  let result;
  let done = false;
  for (;;) {
    // read a value
    ws();
    if (i >= n) return undefined;
    const c = text[i];
    let value;
    let opened = false;
    if (c === "[") {
      i += 1;
      ws();
      if (text[i] === "]") {
        i += 1;
        value = [];
      } else {
        stack.push({ value: [], key: null });
        opened = true;
      }
    } else if (c === "{") {
      i += 1;
      ws();
      if (text[i] === "}") {
        i += 1;
        value = new Map();
      } else {
        // an object: read its first key
        const frame = { value: new Map(), key: null };
        if (text[i] !== '"') return undefined;
        const key = scalar();
        if (key === FAIL) return undefined;
        ws();
        if (text[i] !== ":") return undefined;
        i += 1;
        frame.key = key;
        stack.push(frame);
        opened = true;
      }
    } else {
      value = scalar();
      if (value === FAIL) return undefined;
    }
    if (opened) continue;
    // attach the value and close containers as far as the text does
    for (;;) {
      if (!stack.length) {
        result = value;
        done = true;
        break;
      }
      const frame = stack[stack.length - 1];
      if (frame.value instanceof Map) frame.value.set(frame.key, value);
      else frame.value.push(value);
      ws();
      const d = text[i];
      if (d === ",") {
        i += 1;
        if (frame.value instanceof Map) {
          ws();
          if (text[i] !== '"') return undefined;
          const key = scalar();
          if (key === FAIL) return undefined;
          ws();
          if (text[i] !== ":") return undefined;
          i += 1;
          frame.key = key;
        }
        break; // read the next value
      }
      if ((frame.value instanceof Map && d === "}") || (!(frame.value instanceof Map) && d === "]")) {
        i += 1;
        stack.pop();
        value = frame.value;
        continue;
      }
      return undefined;
    }
    if (done) break;
  }
  ws();
  return i === n ? result : undefined;
}

// One token per JSON string or brace. An unterminated string ends at the line, never at the end of the text, so the
// scan stays linear and a stray quote in prose costs one line.
const JSON_TOKEN = /"[^"\\\n]*(?:\\[\s\S][^"\\\n]*)*(?:"|(?=\n)|$)|[{}]/g;

// Parsed JSON values that may hold a hooks object, in text order.
function jsonCandidates(text) {
  const whole = pyJson(text);
  if (whole instanceof Map || Array.isArray(whole)) return [whole];
  const starts = [];
  const parent = [];
  const close = [];
  const stack = [];
  const hookKeys = [];
  for (const match of text.matchAll(JSON_TOKEN)) {
    const token = match[0];
    const first = token[0];
    if (first === "{") {
      parent.push(stack.length ? stack[stack.length - 1] : -1);
      starts.push(match.index);
      close.push(-1);
      stack.push(starts.length - 1);
    } else if (first === "}") {
      if (stack.length) close[stack.pop()] = match.index + 1;
    } else if (token === '"hooks"' && stack.length) hookKeys.push(stack[stack.length - 1]);
  }
  if (!hookKeys.length) return [];
  // The outermost CLOSED object around each key: an unclosed brace in prose above a real config must not hide the config.
  let maxKey = 0;
  for (const k of hookKeys) if (k > maxKey) maxKey = k;
  const top = new Array(maxKey + 1).fill(-1);
  for (let index = 0; index < top.length; index++) {
    if (close[index] === -1) continue;
    const above = parent[index];
    top[index] = above === -1 || close[above] === -1 ? index : top[above];
  }
  const roots = [];
  const seen = new Set();
  for (const index of hookKeys) {
    if (close[index] === -1) continue;
    const root = top[index];
    if (!seen.has(root)) {
      seen.add(root);
      roots.push(root);
      if (roots.length >= MAX_CANDIDATES) break;
    }
  }
  const parsed = [];
  for (const root of roots) {
    const value = pyJson(text.slice(starts[root], close[root]));
    if (value !== undefined) parsed.push(value);
  }
  return parsed;
}

// Every string `command` under a `hooks` key (bounded depth), in order.
function hookCommands(value) {
  const found = [];
  const stack = [[value, -1]];
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (node instanceof Map) {
      const items = [...node.entries()];
      if (depth >= 0) {
        for (const [key, item] of items) if (key === "command" && typeof item === "string") found.push(item);
      }
      for (let k = items.length - 1; k >= 0; k--) {
        const [key, item] = items[k];
        let child;
        if (depth < 0) child = key === "hooks" ? 0 : -1;
        else {
          child = depth + 1;
          if (child > MAX_HOOKS_DEPTH) continue;
        }
        if (item instanceof Map || Array.isArray(item)) stack.push([item, child]);
      }
    } else if (Array.isArray(node)) {
      const child = depth < 0 ? -1 : depth + 1;
      if (child > MAX_HOOKS_DEPTH) continue;
      for (let k = node.length - 1; k >= 0; k--) {
        const item = node[k];
        if (item instanceof Map || Array.isArray(item)) stack.push([item, child]);
      }
    }
  }
  return found;
}

// ------------------------------------------------------------------------------------------------------ fetchers

const CURL_SHORT_VALUE = new Set("AbcCdDeEFHKmPQrtTuUwxXyYz");
const CURL_LONG_VALUE = new Set([
  "--header", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--user", "--user-agent", "--referer", "--cookie",
  "--cookie-jar", "--max-time", "--connect-timeout", "--retry", "--retry-delay", "--retry-max-time", "--proxy", "--request",
  "--upload-file", "--form", "--range", "--write-out", "--cacert", "--cert", "--key", "--output-dir", "--dump-header", "--config",
]);
const WGET_SHORT_VALUE = new Set("oaetTwPUiBQlARDIXu");
const WGET_LONG_VALUE = new Set([
  "--header", "--user-agent", "--timeout", "--tries", "--directory-prefix", "--output-file", "--post-data", "--referer",
  "--load-cookies", "--wait", "--input-file", "--append-output",
]);
const INFO_LONG = ["--version", "--help", "--manual"];

// The path without leading `./` pairs, found by index so the cost stays linear.
function norm(path) {
  let i = 0;
  while (path.startsWith("./", i)) i += 2;
  return i ? path.slice(i) : path;
}

function urlName(url) {
  if (!url) return null;
  let path = url.split("?")[0].split("#")[0];
  if (path.includes("://")) {
    path = path.slice(path.indexOf("://") + 3);
    if (!path.includes("/")) return null;
    path = path.slice(path.indexOf("/") + 1);
  }
  path = path.replace(/\/+$/, "");
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name || null;
}

const isDigits = (text) => PY_ISDIGIT.test(text);

// A curl / wget segment: does it write to standard output, and where does it save? The destination is known only when
// exactly one token decides it: one output option, or one redirection of standard output, or none.
function parseFetch(programName, args, redirects) {
  const curl = programName === "curl";
  const shortValue = curl ? CURL_SHORT_VALUE : WGET_SHORT_VALUE;
  const longValue = curl ? CURL_LONG_VALUE : WGET_LONG_VALUE;
  const [outShort, outLong] = curl ? ["o", "--output"] : ["O", "--output-document"];
  const outputs = [];
  let remoteName = 0;
  let infoOnly = false;
  let url = null;
  let i = 0;
  const n = args.length;
  while (i < n) {
    const arg = args[i];
    i += 1;
    if (arg.kind !== "w") continue;
    const value = arg.value;
    if (value.startsWith("--") && value.length > 2) {
      const eqAt = value.indexOf("=");
      const name = eqAt < 0 ? value : value.slice(0, eqAt);
      const eq = eqAt >= 0;
      const rest = eq ? value.slice(eqAt + 1) : "";
      if (startsOneOf(name, INFO_LONG)) {
        infoOnly = true; // the start of --version, --help or --manual is that option, or is refused: nothing is fetched
      } else if (name === outLong || (!curl && name.length >= 10 && outLong.startsWith(name))) {
        if (eq) outputs.push(rest);
        else if (i < n && args[i].kind === "w") {
          outputs.push(args[i].value);
          i += 1;
        } else {
          outputs.push(null); // a selector whose argument is not a plain word still counts
          i += 1;
        }
      } else if (curl && (name === "--remote-name" || name === "--remote-name-all")) remoteName += 1;
      else if (name === "--url" && curl) {
        if (eq) url = rest;
        else if (i < n && args[i].kind === "w") {
          url = args[i].value;
          i += 1;
        }
      } else if (longValue.has(name) && !eq) i += 1;
      continue;
    }
    if (value.length > 1 && value[0] === "-") {
      let j = 1;
      while (j < value.length) {
        const ch = value[j];
        if (ch === outShort) {
          const rest = value.slice(j + 1);
          if (rest) outputs.push(rest);
          else if (i < n && args[i].kind === "w") {
            outputs.push(args[i].value);
            i += 1;
          } else {
            outputs.push(null);
            i += 1;
          }
          break;
        }
        if (ch === "V" || ch === "h") infoOnly = true;
        else if (curl && ch === "O") remoteName += 1;
        else if (shortValue.has(ch)) {
          if (j === value.length - 1) i += 1;
          break;
        }
        j += 1;
      }
      continue;
    }
    url = value;
  }
  if (infoOnly) return { program: programName, stdout: false, dests: [] }; // prints its version or help text
  if (outputs.length + redirects.length + remoteName > 1) return { program: programName, stdout: false, dests: [] };
  let stdout = false;
  const dests = [];
  if (outputs.length) {
    if (outputs[0] === null) {
      // its argument is not a plain word: no destination
    } else if (outputs[0] === "-" || outputs[0] === "/dev/stdout") stdout = true;
    else dests.push(norm(outputs[0]));
  } else if (curl) {
    if (remoteName) {
      const name = urlName(url);
      if (name) dests.push(name);
    } else if (redirects.length) {
      const target = redirects[0];
      if (target !== "-" && !isDigits(target) && !target.startsWith("/dev/")) dests.push(norm(target));
    } else stdout = true;
  } else {
    const name = urlName(url);
    if (name) dests.push(name);
  }
  return { program: programName, stdout, dests };
}

// ------------------------------------------------------------------------------------------------------ interpreters

const INTERPRETERS = {
  python: { noop: "VhHZ?", inline: "c", module: "m", value: "WXQ", long_noop: ["--version", "--help", "--help-all"], long_inline: [], long_value: [] },
  node: {
    noop: "chv", inline: "ep", module: "", value: "r", long_noop: ["--version", "--help", "--check"],
    long_inline: ["--eval", "--print"], long_value: ["--require", "--import", "--loader", "--experimental-loader", "--input-type"],
  },
  perl: { noop: "cvVh", inline: "eE", module: "", value: "", long_noop: ["--version", "--help"], long_inline: [], long_value: [] },
  ruby: { noop: "cvh", inline: "e", module: "", value: "rICEKS", long_noop: ["--version", "--help", "--copyright"], long_inline: [], long_value: [] },
};

function interpreterKind(name) {
  if (PYTHON.test(name)) return "python";
  if (name === "node" || name === "nodejs") return "node";
  if (name === "perl" || name === "ruby") return name;
  return null;
}

function runInterpreter(kind, args) {
  const spec = INTERPRETERS[kind];
  let i = 0;
  const n = args.length;
  while (i < n) {
    const arg = args[i];
    if (arg.kind !== "w") break;
    const value = arg.value;
    if (value === "--") {
      i += 1;
      break;
    }
    if (value === "-") break;
    if (value.startsWith("--") && value.length > 2) {
      const eqAt = value.indexOf("=");
      const name = eqAt < 0 ? value : value.slice(0, eqAt);
      if (startsOneOf(name, spec.long_noop)) return new Run("none");
      if (spec.long_inline.includes(name)) {
        return new Run("inline", null, i + 1 < n && args[i + 1].kind === "w" ? args[i + 1] : null);
      }
      if (spec.long_value.includes(name) && !value.includes("=")) i += 1;
      i += 1;
      continue;
    }
    if (value.length > 1 && value[0] === "-") {
      let j = 1;
      while (j < value.length) {
        const ch = value[j];
        if (spec.noop.includes(ch)) return new Run("none");
        if (spec.module.includes(ch)) return new Run("none");
        if (spec.inline.includes(ch)) {
          if (value.slice(j + 1)) return new Run("inline");
          return new Run("inline", null, i + 1 < n && args[i + 1].kind === "w" ? args[i + 1] : null);
        }
        if (spec.value.includes(ch)) {
          if (j === value.length - 1) i += 1;
          break;
        }
        j += 1;
      }
      i += 1;
      continue;
    }
    break;
  }
  if (i >= n || (args[i].kind === "w" && args[i].value === "-")) return new Run("stdin");
  return new Run("file", args[i]);
}

// An interpreter one-liner that fetches a body and runs it in the same code string. `\b` and `\w` of the interpreter's
// patterns are word edges and word characters of any script.
const W = "[\\p{L}\\p{N}_]";
const NOT_AFTER_W = `(?<!${W})`;
const NOT_BEFORE_W = `(?!${W})`;
const SP = `[${PY_SPACE}]*`;
const INLINE_FETCH = {
  python: pinRx(`${NOT_AFTER_W}(urlopen|requests\\.get|httpx\\.get)${SP}\\(`, "u"),
  node: pinRx(
    `(?<![\\p{L}\\p{N}_.])(fetch)${SP}\\(|${NOT_AFTER_W}(https?\\.get)${SP}\\(|(require\\(${SP}['"]https?['"]${SP}\\)\\.get)${SP}\\(|${NOT_AFTER_W}(axios\\.get)${SP}\\(`,
    "u",
  ),
  perl: pinRx(`${NOT_AFTER_W}(LWP::Simple|LWP::UserAgent|HTTP::Tiny)${NOT_BEFORE_W}`, "u"),
  ruby: pinRx(`${NOT_AFTER_W}(Net::HTTP|URI\\.open|open-uri)${NOT_BEFORE_W}|${NOT_AFTER_W}(URI\\.parse)${SP}\\(`, "u"),
};
const INLINE_RUN = {
  python: pinRx(`(?<![\\p{L}\\p{N}_.])(?:exec|eval)${SP}\\(`, "gu"),
  node: pinRx(
    `(?<![\\p{L}\\p{N}_.])(?:eval|Function)${SP}\\(|${NOT_AFTER_W}new[${PY_SPACE}]+Function${NOT_BEFORE_W}|\\.then${SP}\\(${SP}eval${SP}\\)`,
    "gu",
  ),
  perl: pinRx(`(?<![\\p{L}\\p{N}_:$@%&])eval${NOT_BEFORE_W}`, "gu"),
  ruby: pinRx(
    `(?<![\\p{L}\\p{N}_.])(?:eval|instance_eval|class_eval)${NOT_BEFORE_W}|\\.(?:instance_eval|class_eval)${NOT_BEFORE_W}`,
    "gu",
  ),
};

// The fetching call when interpreter code fetches over the network and runs a string as code, else null. The run follows
// the first fetch, or is the call that holds it as an argument. Names are matched in the one code string.
function inlineFetchAndRun(kind, code) {
  const fetch = INLINE_FETCH[kind].exec(code);
  if (fetch === null) return null;
  const name = fetch.slice(1).find((g) => g);
  const run = INLINE_RUN[kind];
  run.lastIndex = fetch.index + fetch[0].length;
  if (run.exec(code) !== null) return name;
  // the last run that ends before the fetch starts, in the text cut at the fetch
  const head = code.slice(0, fetch.index);
  let held = null;
  run.lastIndex = 0;
  for (let m = run.exec(head); m !== null; m = run.exec(head)) {
    held = m;
    if (m[0].length === 0) run.lastIndex += 1;
  }
  if (held === null) return null;
  let depth = 1; // the run's own open bracket
  for (let k = held.index + held[0].length; k < head.length; k++) {
    const ch = head[k];
    if (ch === ";" || ch === "\n") return null;
    if (ch === "(" || ch === "{" || ch === "[") depth += 1;
    if (ch === ")" || ch === "}" || ch === "]") depth -= 1;
    if (depth <= 0) return null;
  }
  return name;
}

const evidence = (link, fetch, runner) => ({ link, fetch, runner });

// ------------------------------------------------------------------------------------------------------ filters

// Programs that write their own output and never pass on what they read: a pipe through one of them carries no fetched
// bytes to the next stage.
const DISCARDS_STREAM = new Set([
  "echo", "printf", "true", "false", ":", "date", "pwd", "ls", "seq", "yes", "hostname", "uname", "id", "whoami", "sleep",
  "logger", "notify-send", "osascript", "test", "[", "read", "wc", "cksum", "sum", "cmp", "md5", "md5sum", "shasum",
  "sha1sum", "sha224sum", "sha256sum", "sha384sum", "sha512sum", "b2sum",
]);

// Options of the common filters that take a separate value: [short letters, long names].
const FILTER_VALUE_OPTIONS = new Map([
  ["grep", ["efmABCdD", ["--regexp", "--file", "--max-count", "--after-context", "--before-context", "--context", "--directories", "--devices", "--include", "--exclude", "--exclude-from", "--exclude-dir", "--label", "--binary-files"]]],
  ["sed", ["efl", ["--expression", "--file", "--line-length"]]],
  ["awk", ["fvF", ["--file", "--assign", "--field-separator", "--source"]]],
  ["head", ["nc", ["--lines", "--bytes"]]],
  ["tail", ["ncs", ["--lines", "--bytes", "--pid", "--sleep-interval", "--max-unchanged-stats"]]],
  ["cut", ["bcdf", ["--bytes", "--characters", "--delimiter", "--fields", "--output-delimiter"]]],
  ["sort", ["ktTSo", ["--key", "--field-separator", "--temporary-directory", "--buffer-size", "--output", "--parallel", "--files0-from", "--batch-size", "--compress-program", "--random-source"]]],
  ["uniq", ["fsw", ["--skip-fields", "--skip-chars", "--check-chars"]]],
  ["jq", ["fL", ["--from-file", "--indent", "--arg", "--argjson", "--slurpfile", "--rawfile"]]],
  ["cat", ["", []]], ["tee", ["", []]], ["tr", ["", []]], ["rev", ["", []]], ["tac", ["", []]],
  ["nl", ["bdfhilnsvw", ["--body-numbering", "--section-delimiter", "--footer-numbering", "--header-numbering", "--line-increment", "--join-blank-lines", "--number-format", "--number-separator", "--starting-line-number", "--number-width"]]],
  ["fold", ["w", ["--width"]]],
  ["expand", ["t", ["--tabs"]]], ["unexpand", ["t", ["--tabs"]]],
  ["paste", ["d", ["--delimiters"]]],
  ["column", ["cslNoOREHTW", []]],
  ["xxd", ["cglos", []]],
  ["od", ["AjNt", ["--address-radix", "--skip-bytes", "--read-bytes", "--format"]]],
  ["strings", ["nte", ["--bytes", "--radix", "--encoding"]]],
  ["iconv", ["ft", ["--from-code", "--to-code"]]],
  ["base64", ["wbo", ["--wrap"]]],
]);
for (const [alias, of] of [["egrep", "grep"], ["fgrep", "grep"], ["gawk", "awk"], ["mawk", "awk"]]) {
  FILTER_VALUE_OPTIONS.set(alias, FILTER_VALUE_OPTIONS.get(of));
}
const TWO_VALUE_LONG = ["--arg", "--argjson", "--slurpfile", "--rawfile"];

// How many following words the option word `value` of a filter with table entry `known` takes as values.
function optionTakesNextWord(value, known) {
  const [letters, longs] = known;
  if (value.startsWith("--")) {
    const eqAt = value.indexOf("=");
    const name = eqAt < 0 ? value : value.slice(0, eqAt);
    if (eqAt >= 0 || name.length < 3) return 0;
    if (["--version", "--help"].some((info) => info.startsWith(name))) return 0;
    if (TWO_VALUE_LONG.includes(name)) return 2;
    return longs.some((option) => option.startsWith(name)) ? 1 : 0;
  }
  for (let position = 1; position < value.length; position++) {
    if (letters.includes(value[position])) return position === value.length - 1 ? 1 : 0;
  }
  return 0;
}

// Words taken by the option word `value` of a filter whose options are not listed above.
function unlistedOptionTakesNextWord(value) {
  const eqAt = value.indexOf("=");
  const name = eqAt < 0 ? value : value.slice(0, eqAt);
  if (!value.startsWith("--") || eqAt >= 0 || name.length < 3) return 0;
  return ["--version", "--help"].some((info) => info.startsWith(name)) ? 0 : 1;
}

const beforeEquals = (value) => {
  const at = value.indexOf("=");
  return at < 0 ? value : value.slice(0, at);
};

// Is the program asked to print its version or help text, which reads no input? A word counts only where it is an
// option: not the value of an option that takes one, and not after the `--` that ends the options.
function informational(name, args) {
  const known = FILTER_VALUE_OPTIONS.get(name);
  let skip = 0;
  for (const arg of args) {
    if (arg.kind !== "w") {
      skip = 0;
      continue;
    }
    if (skip) {
      if (known === undefined && startsOneOf(beforeEquals(arg.value), ["--version", "--help"])) return true;
      skip -= 1;
      continue;
    }
    if (arg.value === "--") break;
    if (startsOneOf(beforeEquals(arg.value), ["--version", "--help"])) return true;
    if (arg.value.startsWith("-")) {
      skip = known !== undefined ? optionTakesNextWord(arg.value, known) : unlistedOptionTakesNextWord(arg.value);
    }
  }
  return false;
}

function discardsStream(name, args) {
  if (DISCARDS_STREAM.has(name) || informational(name, args)) return true;
  if (name === "cat") return args.some((a) => a.kind === "w" && a.value !== "-" && !a.value.startsWith("-"));
  return false;
}

// ------------------------------------------------------------------------------------------------------ the walk

// [link, fetch program] for the bytes the segment reads on standard input, or null. A redirection replaces the pipe.
function inputOf(segment, stream, downloaded, depth) {
  const redirect = stdinRedirect(segment);
  if (redirect === null) return stream ? ["pipe", stream] : null;
  const [op, target] = redirect;
  if (target === null) return null;
  if (op === "<<<" && target.kind === "w" && target.lead) {
    for (const body of target.subs) {
      const fetched = fetchesToStdout(body, depth + 1);
      if (fetched) return ["command_substitution", fetched];
    }
  } else if (op === "<" && target.kind === "ps") {
    const fetched = fetchesToStdout(target.value, depth + 1);
    if (fetched) return ["process_substitution", fetched];
  } else if (op === "<" && target.kind === "w" && downloaded.has(norm(target.value))) {
    return ["download_then_run", downloaded.get(norm(target.value))];
  }
  return null;
}

// The fetch program whose bytes the segment writes to the pipe, after its own redirections. Output sent to a file leaves
// the pipe empty and leaves the file holding those bytes.
function emit(segment, out, downloaded) {
  const found = stdoutRedirects(segment);
  const dest = found.length ? found[found.length - 1] : null;
  if (dest === null) return out;
  if (out && dest !== "-" && !isDigits(dest) && !dest.startsWith("/dev/")) downloaded.set(norm(dest), out);
  return null;
}

// A later write to a downloaded file replaces what was downloaded.
function forgetOverwritten(segment, name, args, downloaded) {
  for (const [operator, target] of segment.redirs) {
    if (target === null || target.kind !== "w") continue;
    const op = operator.replace(/^[0-9&]+/, "");
    if (op === ">" || op === ">|" || (op === ">&" && !isDigits(target.value) && target.value !== "-")) {
      downloaded.delete(norm(target.value));
    }
  }
  if (name === "cp" || name === "mv" || name === "install") {
    const operands = args.filter((a) => a.kind === "w" && !a.value.startsWith("-")).map((a) => a.value);
    if (operands.length >= 2) {
      const dest = norm(operands[operands.length - 1]);
      const sources = operands.slice(0, -1).map(norm);
      const first = sources.find((s) => downloaded.has(s));
      const fetched = first === undefined ? null : downloaded.get(first);
      if (name === "mv") for (const s of sources) downloaded.delete(s);
      if (fetched) downloaded.set(dest, fetched);
      else downloaded.delete(dest);
    }
  }
}

const isKnownProgram = (name) => SHELLS.has(name) || name === "source" || name === "." || name === "eval" || interpreterKind(name) !== null;

// [evidence, emitted] for `cmd`. evidence is the first fetch-and-run link, or null. emitted is the fetch program whose
// bytes reach the command's standard output, or null; a substitution is judged by it. With `links` off the walk only
// follows the bytes.
function walk(cmd, depth, downloadedIn, links = true) {
  let segs;
  try {
    segs = segments(lex(cmd));
  } catch (error) {
    if (error instanceof Syntax || error instanceof RangeError) return [null, null];
    throw error;
  }
  const downloaded = new Map(downloadedIn); // normalised path -> fetch program
  let carried = null; // fetch program whose bytes reach the next piped segment
  let emitted = null;
  let deadAnd = false;
  let deadOr = false;
  let stoppedHere = false;
  for (const segment of segs) {
    const before = segment.sepBefore;
    const piped = before === "|" || before === "|&";
    if (carried && !piped) emitted = emitted || carried; // the pipeline before this segment has ended
    // word-level reachability: `false && x`, `true || x`, and everything after `exit`
    if (stoppedHere) break;
    if (deadAnd && before === "&&") {
      carried = null;
      continue;
    }
    deadAnd = false;
    if (deadOr && before === "||") {
      carried = null;
      continue;
    }
    deadOr = false;
    const stream = piped ? carried : null;
    carried = null;
    const located = program(segment.words);
    if (located === null) {
      forgetOverwritten(segment, null, [], downloaded); // `> file` empties the file
      continue;
    }
    const [head, args] = located;
    const name = base(head.value);
    if (name === "exit" || name === "return") {
      stoppedHere = true;
      continue;
    }
    if (name === "false" && segment.sepAfter === "&&") {
      deadAnd = true;
      continue;
    }
    if ((name === "true" || name === ":") && segment.sepAfter === "||") {
      deadOr = true;
      continue;
    }
    if (links && head.lead && head.subs.length) {
      // the command word is itself a substitution: the shell runs what the substitution prints
      const fetched = fetchesToStdout(head.subs[0], depth + 1);
      if (fetched) return [evidence("command_substitution", fetched, "command"), emitted];
    }
    if (name === "curl" || name === "wget") {
      forgetOverwritten(segment, name, args, downloaded); // every `>` target is emptied first
      const fetch = parseFetch(name, args, stdoutRedirects(segment));
      for (const path of fetch.dests) downloaded.set(path, name);
      carried = fetch.stdout ? name : null;
      continue;
    }
    forgetOverwritten(segment, name, args, downloaded);
    const got = inputOf(segment, stream, downloaded, depth);
    if (name === "tee") {
      if (informational(name, args)) continue;
      const appends = args.some(
        (a) => a.kind === "w" && (a.value === "-a" || a.value === "--append" || (a.value.startsWith("-") && !a.value.startsWith("--") && a.value.includes("a"))),
      );
      for (const arg of args) {
        if (arg.kind === "w" && !arg.value.startsWith("-")) {
          if (got) downloaded.set(norm(arg.value), got[1]);
          else if (!appends) downloaded.delete(norm(arg.value));
        }
      }
      carried = emit(segment, got ? got[1] : null, downloaded);
      continue;
    }
    if (links) {
      // a direct run of a file that was downloaded earlier in the chain
      if (downloaded.has(norm(head.value)) && !isKnownProgram(name)) {
        return [evidence("download_then_run", downloaded.get(norm(head.value)), name), emitted];
      }
      let run = null;
      if (SHELLS.has(name)) run = runShell(args);
      else if (name === "source" || name === ".") {
        const operand = args.find((a) => a.kind === "ps" || !a.value.startsWith("-"));
        run = operand !== undefined ? new Run("file", operand) : new Run("none");
      } else if (name === "eval") run = new Run("inline", null, args.length && args[0].kind === "w" ? args[0] : null);
      else {
        const kind = interpreterKind(name);
        if (kind) run = runInterpreter(kind, args);
      }
      if (run !== null) {
        const found = link(run, name, args, got, downloaded, depth);
        if (found) return [found, emitted];
        continue;
      }
    } else if (isKnownProgram(name)) continue; // what a runner writes is not the bytes it was given
    // an ordinary filter keeps the bytes flowing; a printer replaces them
    const out = got === null || discardsStream(name, args) ? null : got[1];
    carried = emit(segment, out, downloaded);
  }
  if (carried) emitted = emitted || carried;
  return [null, emitted];
}

const analyze = (cmd, depth, downloaded) => walk(cmd, depth, downloaded)[0];

// Does a substitution body write fetched bytes to its standard output? The program, or null.
function fetchesToStdout(body, depth) {
  if (depth > MAX_NESTED_COMMANDS) return null;
  return walk(body, depth, new Map(), false)[1];
}

function link(run, name, args, got, downloaded, depth) {
  if (run.mode === "stdin") return got ? evidence(got[0], got[1], name) : null;
  if (run.mode === "file") {
    const operand = run.operand;
    if (operand.kind === "ps") {
      const fetched = fetchesToStdout(operand.value, depth + 1);
      return fetched ? evidence("process_substitution", fetched, name) : null;
    }
    if (operand.lead) {
      for (const body of operand.subs) {
        const fetched = fetchesToStdout(body, depth + 1);
        if (fetched) return evidence("command_substitution", fetched, name);
      }
    }
    const path = norm(operand.value);
    return downloaded.has(path) ? evidence("download_then_run", downloaded.get(path), name) : null;
  }
  if (run.mode === "inline") {
    const wordTok = run.inline;
    if (wordTok === null) return null;
    if (wordTok.lead) {
      for (const body of wordTok.subs) {
        const fetched = fetchesToStdout(body, depth + 1);
        if (fetched) return evidence("command_substitution", fetched, name);
      }
    }
    const kind = interpreterKind(name);
    if (kind) {
      const fetched = inlineFetchAndRun(kind, wordTok.value);
      if (fetched) return evidence("inline_code", fetched, name);
    }
    if (SHELLS.has(name) || name === "eval") {
      if (depth < MAX_NESTED_COMMANDS) {
        const text = name !== "eval" ? wordTok.value : args.filter((a) => a.kind === "w").map((a) => a.value).join(" ");
        return analyze(text, depth + 1, downloaded);
      }
    }
  }
  return null;
}

// Evidence for a hook command that downloads code and runs it, else null.
export function classifyCommand(cmd) {
  if (typeof cmd !== "string") return null;
  try {
    return analyze(cmd, 0, new Map());
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

export const HookFetchAndRun = {
  id: "GLS-STRUCT-001",
  name: "Hook command fetches and runs remote code",
  category: "supply_chain",
  severity: "critical",
  channel: ["message", "file", "tool_output", "web_content"],
  description:
    "A hook command in this configuration reads as one that downloads code and hands " +
    "it to a shell or an interpreter, which would run whatever the server sends next, " +
    "with the user's rights, when the hook's event fires.",

  pregate(text) {
    // The program names are not tested here: a shell reads `cu''rl` and `c\url` as curl, so only the JSON structure is
    // required. `\u` allows for JSON escapes that spell a key differently.
    if (!text.includes("{")) return false;
    const hasKey = text.includes("hooks") || text.includes("\\u");
    const hasCommand = text.includes("command") || text.includes("\\u");
    return hasKey && hasCommand;
  },

  run(text) {
    stopped.atLimit = false;
    const commands = [];
    for (const candidate of jsonCandidates(text)) for (const c of hookCommands(candidate)) commands.push(c);
    const findings = [];
    for (const cmd of new Set(commands)) {
      const found = classifyCommand(cmd);
      if (found === null) continue;
      findings.push({
        id: this.id,
        name: this.name,
        category: this.category,
        severity: this.severity,
        channel: [...this.channel],
        description: this.description,
        matched_text: cpHead(cmd, 50),
        structural: true,
        evidence: found,
      });
    }
    return findings;
  },
};
