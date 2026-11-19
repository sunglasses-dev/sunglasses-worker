// A small shell lexer: words, process substitutions, redirections and operators, then pipeline segments, and the
// words of a command past its wrapper programs. Port of the pip scanner's validators.py shell side. A reader of
// words, not a shell: it does not run anything.
import { PY_SPACE } from "./py_text.js";

export class TooBig extends Error {}
export class Syntax extends Error {}

// What an engine that stops at a limit leaves behind for the validator that started it.
export const stopped = { atLimit: false };

export class Tok {
  constructor(kind, value, subs = [], lead = false) {
    this.kind = kind; // "w" word | "ps" process substitution | "redir" | "op"
    this.value = value; // word text with quotes removed; ps/command body; operator text
    this.subs = subs; // bodies of $(...) and backticks inside a word
    this.lead = lead; // a substitution is the first thing in the word
    this.body = null; // a here-document delimiter: the lines up to the delimiter (script reader only)
    this.expand = true; // a here-document delimiter: false when it was quoted, so the body is literal
    this.at = 0; // offset in the text where the token starts (script reader only)
    this.bodyAt = 0; // a here-document delimiter: offset where its body starts
    this.subAt = []; // offsets from the token start where each of `subs` begins
    this.depth = 0; // a word made by splitting a string: how many split strings it came out of
  }
}

export const DOLLAR = "\x00"; // a '$' the shell leaves alone (single quotes, backslash)

const sticky = (source, flags = "") => new RegExp(source, "y" + flags);
const WS = sticky("[ \\t\\r\\f\\v]+");
export const PLAIN_SOURCE = `[^${PY_SPACE}'"\\\\\`$|&;<>()]+`;
const PLAIN = sticky(PLAIN_SOURCE);
const PLAIN_FULL = new RegExp(`^${PLAIN_SOURCE}$`);
const DQ_RUN = sticky('[^"\\\\$`]+');
const BRACKET = new RegExp("[()'\"\\\\`]", "g");
const REDIR = sticky("(?:\\p{Nd}+|&)?(?:>>|>&|>\\||>|<<<|<<-?|<&|<>|<)", "u");
const OP = sticky("\\|\\||\\|&|\\||&&|&|;;|;|\\(|\\)|\\n");
export const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

function closingBacktick(s, i) {
  const n = s.length;
  let j = i + 1;
  while (j < n) {
    const c = s[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "`") return j;
    j += 1;
  }
  throw new Syntax();
}

function skipDoubleQuote(s, i) {
  const n = s.length;
  let j = i + 1;
  while (j < n) {
    const c = s[j];
    if (c === "\\") j += 2;
    else if (c === '"') return j + 1;
    else if (c === "$" && s.startsWith("$(", j)) j = balanced(s, j + 1);
    else if (c === "`") j = closingBacktick(s, j) + 1;
    else j += 1;
  }
  throw new Syntax();
}

// Index just after the `)` that closes the `(` at s[i].
export function balanced(s, i) {
  let depth = 0;
  let pos = i;
  for (;;) {
    BRACKET.lastIndex = pos;
    const match = BRACKET.exec(s);
    if (match === null) throw new Syntax();
    const c = match[0];
    const at = match.index;
    if (c === "(") {
      depth += 1;
      pos = at + 1;
    } else if (c === ")") {
      depth -= 1;
      pos = at + 1;
      if (depth === 0) return pos;
    } else if (c === "\\") pos = at + 2;
    else if (c === "'") {
      const end = s.indexOf("'", at + 1);
      if (end < 0) throw new Syntax();
      pos = end + 1;
    } else if (c === '"') pos = skipDoubleQuote(s, at);
    else pos = closingBacktick(s, at) + 1;
  }
}

// A list of strings that knows how long they are together.
class Parts {
  constructor() {
    this.a = [];
    this.n = 0;
  }
  push(text) {
    this.n += text.length;
    this.a.push(text);
  }
  get length() {
    return this.a.length;
  }
  join() {
    return this.a.join("");
  }
}

// Read one shell word at s[i]; returns [token, next index]. With `literal` a `$` that quoting or a backslash protects
// is returned as DOLLAR. With a `trace` list it gets one [offset in s, length of the word's text so far, source
// characters the construct drops before its text] per construct, then one for the end.
export function word(s, i, literal = false, trace = null) {
  const n = s.length;
  const parts = new Parts();
  const subs = [];
  const where = [];
  const origin = i;
  let lead = false;
  let seen = false;
  while (i < n) {
    let c = s[i];
    if (trace !== null) trace.push([i, parts.n, c === "'" || c === "\\" ? 1 : s.startsWith("$'", i) ? 2 : 0]);
    PLAIN.lastIndex = i;
    const plain = PLAIN.exec(s);
    if (plain !== null) {
      parts.push(plain[0]);
      seen = true;
      i = PLAIN.lastIndex;
      continue;
    }
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) throw new Syntax();
      const piece = s.slice(i + 1, end);
      parts.push(literal ? piece.split("$").join(DOLLAR) : piece);
      seen = true;
      i = end + 1;
    } else if (c === '"') {
      seen = true;
      i += 1;
      const buf = new Parts();
      for (;;) {
        if (i >= n) throw new Syntax();
        c = s[i];
        if (trace !== null) trace.push([i, parts.n + buf.n, c === "\\" ? 1 : 0]);
        if (c === '"') {
          i += 1;
          break;
        }
        if (c === "\\") {
          const nxt = s.slice(i + 1, i + 2);
          if (nxt === '"' || nxt === "\\" || nxt === "$" || nxt === "`") {
            buf.push(literal && nxt === "$" ? DOLLAR : nxt);
            i += 2;
          } else if (nxt === "\n") i += 2;
          else {
            buf.push("\\");
            i += 1;
          }
        } else if (c === "$" && s.startsWith("$(", i)) {
          const end = balanced(s, i + 1);
          if (parts.length === 0 && buf.length === 0) lead = true;
          subs.push(s.slice(i + 2, end - 1));
          where.push(i + 2 - origin);
          buf.push(s.slice(i, end));
          i = end;
        } else if (c === "`") {
          const end = closingBacktick(s, i);
          if (parts.length === 0 && buf.length === 0) lead = true;
          subs.push(s.slice(i + 1, end));
          where.push(i + 1 - origin);
          buf.push(s.slice(i, end + 1));
          i = end + 1;
        } else {
          DQ_RUN.lastIndex = i;
          const run = DQ_RUN.exec(s);
          if (run !== null) {
            buf.push(run[0]);
            i = DQ_RUN.lastIndex;
          } else {
            buf.push(c); // a lone '$'
            i += 1;
          }
        }
      }
      parts.push(buf.join());
    } else if (c === "\\") {
      if (i + 1 < n) {
        if (s[i + 1] !== "\n") {
          parts.push(literal && s[i + 1] === "$" ? DOLLAR : s[i + 1]);
          seen = true;
        }
        i += 2;
      } else {
        parts.push("\\");
        seen = true;
        i += 1;
      }
    } else if (c === "`") {
      const end = closingBacktick(s, i);
      if (parts.length === 0) lead = true;
      subs.push(s.slice(i + 1, end));
      where.push(i + 1 - origin);
      parts.push(s.slice(i, end + 1));
      seen = true;
      i = end + 1;
    } else if (c === "$") {
      if (s.startsWith("$(", i)) {
        const end = balanced(s, i + 1);
        if (parts.length === 0) lead = true;
        subs.push(s.slice(i + 2, end - 1));
        where.push(i + 2 - origin);
        parts.push(s.slice(i, end));
        i = end;
      } else if (s.startsWith("${", i)) {
        const end = s.indexOf("}", i);
        if (end < 0) throw new Syntax();
        parts.push(s.slice(i, end + 1));
        i = end + 1;
      } else if (s.startsWith("$'", i)) {
        let end = i + 2;
        while (end < n && s[end] !== "'") end += s[end] === "\\" ? 2 : 1;
        if (end >= n) throw new Syntax();
        parts.push(s.slice(i + 2, end));
        i = end + 1;
      } else {
        parts.push("$");
        i += 1;
      }
      seen = true;
    } else break;
  }
  if (!seen) throw new Syntax();
  if (trace !== null) trace.push([i, parts.n, 0]);
  const made = new Tok("w", parts.join(), subs, lead);
  made.subAt = where;
  return [made, i];
}

// Split a command line into word / ps / redir / op tokens.
export function lex(cmd) {
  const toks = [];
  const n = cmd.length;
  let i = 0;
  let heredocs = [];
  while (i < n) {
    const c = cmd[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v") {
      WS.lastIndex = i;
      WS.exec(cmd);
      i = WS.lastIndex;
      continue;
    }
    if (c === "\\" && cmd.startsWith("\n", i + 1)) {
      i += 2;
      continue;
    }
    if (c === "#") {
      const end = cmd.indexOf("\n", i);
      i = end < 0 ? n : end;
      continue;
    }
    if (c === "\n") {
      toks.push(new Tok("op", "\n"));
      i += 1;
      for (const [delim, strip] of heredocs) {
        while (i < n) {
          const end = cmd.indexOf("\n", i);
          const line = cmd.slice(i, end < 0 ? n : end);
          i = end < 0 ? n : end + 1;
          if ((strip ? line.replace(/^\t+/, "") : line) === delim) break;
        }
      }
      heredocs = [];
      continue;
    }
    if ((c === "<" || c === ">") && cmd.startsWith("(", i + 1)) {
      const end = balanced(cmd, i + 1);
      toks.push(new Tok("ps", cmd.slice(i + 2, end - 1)));
      i = end;
      continue;
    }
    REDIR.lastIndex = i;
    const redir = REDIR.exec(cmd);
    if (redir !== null) {
      toks.push(new Tok("redir", redir[0]));
      i = REDIR.lastIndex;
      if (redir[0].endsWith("<<") || redir[0].endsWith("<<-")) {
        while (i < n && (cmd[i] === " " || cmd[i] === "\t")) i += 1;
        const [w, next] = word(cmd, i);
        i = next;
        toks.push(w);
        heredocs.push([w.value, redir[0].endsWith("<<-")]);
      }
      continue;
    }
    OP.lastIndex = i;
    const op = OP.exec(cmd);
    if (op !== null) {
      toks.push(new Tok("op", op[0]));
      i = OP.lastIndex;
      continue;
    }
    const [w, next] = word(cmd, i);
    i = next;
    toks.push(w);
  }
  return toks;
}

// The lexer for a whole script: it keeps the body of each here-document on its delimiter token, records where every
// token starts, and skips a line it cannot read, so one bad line does not hide the rest. After MAX_BAD_LINES such lines
// the rest is read one line at a time. `fences`, when a list, makes a markdown fence line a line to skip and receives
// the offset of each one.
const MAX_BAD_LINES = 8;
export const FENCE_OPEN = new RegExp(`^ {0,3}(\`{3,}|~{3,})[ \\t]*([^${PY_SPACE}\`]*)`);
export const FENCE_SHUT = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

export function heredocBody(text, i, opener, strip, base = 0) {
  const n = text.length;
  opener.bodyAt = base + i;
  const lines = [];
  while (i < n) {
    const pieces = [];
    let line;
    for (;;) {
      const end = text.indexOf("\n", i);
      line = text.slice(i, end < 0 ? n : end);
      i = end < 0 ? n : end + 1;
      if (strip) line = line.replace(/^\t+/, "");
      pieces.push(line);
      const slashes = line.length - line.replace(/\\+$/, "").length;
      if (!(opener.expand && i < n && slashes % 2)) break;
    }
    const logical =
      pieces.length === 1 ? pieces[0] : pieces.slice(0, -1).map((p) => p.slice(0, -1)).join("") + pieces[pieces.length - 1];
    if (logical === opener.value) break;
    for (const p of pieces) lines.push(p);
  }
  opener.body = lines.join("\n");
  return i;
}

// The part of a redirection operator after its descriptor: [descriptor, operator]. The descriptor is ASCII digits only.
export function redirectParts(operator) {
  const m = /^[0-9]*/.exec(operator)[0];
  return [m, operator.slice(m.length)];
}

export function lexScript(text, base = 0, alone = false, fences = null) {
  const toks = [];
  const n = text.length;
  let i = 0;
  let openers = [];
  let bad = 0;
  while (i < n) {
    if (fences !== null && (i === 0 || text[i - 1] === "\n")) {
      const end = text.indexOf("\n", i);
      if (FENCE_OPEN.test(text.slice(i, end < 0 ? n : end))) {
        fences.push(base + i);
        i = end < 0 ? n : end;
        continue;
      }
    }
    const c = text[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v") {
      WS.lastIndex = i;
      WS.exec(text);
      i = WS.lastIndex;
      continue;
    }
    if (c === "\\" && text.startsWith("\n", i + 1)) {
      i += 2;
      continue;
    }
    if (c === "#") {
      const end = text.indexOf("\n", i);
      i = end < 0 ? n : end;
      continue;
    }
    if (c === "\n") {
      const tok = new Tok("op", "\n");
      tok.at = base + i;
      toks.push(tok);
      i += 1;
      for (const [opener, strip] of openers) i = heredocBody(text, i, opener, strip, base);
      openers = [];
      continue;
    }
    const start = i;
    const made = [];
    try {
      if ((c === "<" || c === ">") && text.startsWith("(", i + 1)) {
        const end = balanced(text, i + 1);
        made.push(new Tok("ps", text.slice(i + 2, end - 1)));
        i = end;
      } else {
        REDIR.lastIndex = i;
        const redir = REDIR.exec(text);
        let op = null;
        if (redir === null) {
          OP.lastIndex = i;
          op = OP.exec(text);
        }
        if (redir !== null) {
          made.push(new Tok("redir", redir[0]));
          i = REDIR.lastIndex;
          const here = redirectParts(redir[0])[1];
          if (here === "<<" || here === "<<-") {
            while (i < n && (text[i] === " " || text[i] === "\t")) i += 1;
            const [w, j] = word(text, i, true);
            w.expand = ![...text.slice(i, j)].some((ch) => ch === "'" || ch === '"' || ch === "\\");
            w.at = base + i;
            made.push(w);
            i = j;
            openers.push([w, redir[0].endsWith("<<-")]);
          }
        } else if (op !== null) {
          made.push(new Tok("op", op[0]));
          i = OP.lastIndex;
        } else {
          const [w, j] = word(text, i, true);
          made.push(w);
          i = j;
        }
      }
    } catch (error) {
      if (!(error instanceof Syntax || error instanceof RangeError)) throw error;
      bad += 1;
      if (bad > MAX_BAD_LINES && !alone) {
        let pos = start;
        while (pos < n) {
          let end = text.indexOf("\n", pos);
          end = end < 0 ? n : end;
          for (const t of lexScript(text.slice(pos, end), base + pos, true, fences)) toks.push(t);
          if (end < n) {
            const newline = new Tok("op", "\n");
            newline.at = base + end;
            toks.push(newline);
          }
          pos = end + 1;
        }
        return toks;
      }
      const end = text.indexOf("\n", start);
      i = end < 0 ? n : end;
      continue;
    }
    made[0].at = base + start;
    for (const t of made) toks.push(t);
  }
  return toks;
}

export class Segment {
  constructor(sepBefore) {
    this.words = [];
    this.redirs = []; // [operator, target word]
    this.sepBefore = sepBefore;
    this.sepAfter = null;
    this.opens = 0; // '(' that open a group before this command
    this.closes = 0; // ')' that close a group after it
  }
}

export function segments(toks) {
  const out = [];
  let current = new Segment(null);
  let pending = null;
  let i = 0;
  const n = toks.length;
  while (i < n) {
    const tok = toks[i];
    i += 1;
    if (tok.kind === "op") {
      if (current.words.length || current.redirs.length) {
        current.sepAfter = tok.value;
        out.push(current);
        current = new Segment(null);
      }
      if (tok.value === "(") current.opens += 1;
      else if (tok.value === ")" && out.length) out[out.length - 1].closes += 1;
      if (tok.value === "(" || tok.value === ")") {
        if (pending === null) pending = ";";
      } else pending = tok.value;
      current.sepBefore = pending;
      continue;
    }
    if (!(current.words.length || current.redirs.length)) {
      current.sepBefore = pending !== null ? pending : current.sepBefore;
    }
    if (tok.kind === "redir") {
      const target = i < n && (toks[i].kind === "w" || toks[i].kind === "ps") ? toks[i] : null;
      if (target !== null) i += 1;
      current.redirs.push([tok.value, target]);
    } else current.words.push(tok);
  }
  if (current.words.length || current.redirs.length) out.push(current);
  return out;
}

export const KEYWORDS = new Set(["if", "then", "else", "elif", "while", "until", "do", "!", "{", "}"]);

const WRAPPER_VALUE_OPTIONS = {
  env: new Set(["-u", "-C", "-S", "-P", "--unset", "--chdir", "--split-string"]),
  command: new Set(),
  builtin: new Set(),
  exec: new Set(["-a"]),
  nohup: new Set(),
  time: new Set(["-f", "-o", "--format", "--output"]),
  nice: new Set(["-n", "--adjustment"]),
  ionice: new Set(["-c", "-n", "-p", "-P", "-u", "--class", "--classdata"]),
  sudo: new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T", "--user", "--group", "--chdir", "--host", "--prompt", "--role", "--type"]),
  doas: new Set(["-u", "-C"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  setsid: new Set(),
  caffeinate: new Set(["-t", "-w"]),
  xargs: new Set(["-n", "-I", "-P", "-d", "-L", "-s", "-E", "-a"]),
};
const DURATION = /^\p{Nd}+(?:\.\p{Nd}+)?[smhd]?$/u;

const WRAPPER_NOEXEC_LONG = {
  env: ["--help", "--version"],
  sudo: ["--list", "--validate", "--version", "--help"],
  timeout: ["--help", "--version"],
  nice: ["--help", "--version"],
  nohup: ["--help", "--version"],
  stdbuf: ["--help", "--version"],
  xargs: ["--help", "--version"],
  ionice: ["--help", "--version"],
  time: ["--help", "--version"],
  setsid: ["--help", "--version"],
};
const WRAPPER_NOEXEC_SHORT = { sudo: "lVv" };

// Is the long option `name` one of `options` or the start of one? `--` alone is not a start.
export function startsOneOf(name, options) {
  return name.length > 2 && options.some((option) => option.startsWith(name));
}

// The short-option word of `env`, its letters read in order: [kind, index of the letter].
function envCluster(value) {
  for (let i = 1; i < value.length; i++) {
    const ch = value[i];
    if (ch === "u" || ch === "C" || ch === "P") return ["value", i];
    if (ch === "S") return ["split", i];
    if (ch !== "i" && ch !== "v" && ch !== "-") return ["bad", i];
  }
  return ["plain", 0];
}

const ENV_LONG = [
  ["ignore-environment", "no"], ["env0-from", "must"], ["null", "no"], ["unset", "must"], ["chdir", "must"],
  ["argv0", "must"], ["debug", "no"], ["split-string", "must"], ["block-signal", "may"], ["default-signal", "may"],
  ["ignore-signal", "may"], ["list-signal-handling", "no"], ["help", "no"], ["version", "no"],
];

// A split string whose words hold another split string is read again from the shorter text, to this many levels.
const ENV_SPLIT_LIMIT = 16;

// The string without its leading run of attached `-S`, when the string is one plain word.
function peelSplitRun(string) {
  if (!PLAIN_FULL.test(string)) return string;
  let at = 0;
  while (string.startsWith("-S", at) && at + 2 < string.length) at += 2;
  return string.slice(at);
}

// The long option word of `env`: "split", "value", "plain", or "exit".
function envLong(value) {
  const rest = value.slice(2);
  const eqAt = rest.indexOf("=");
  const name = eqAt < 0 ? rest : rest.slice(0, eqAt);
  const eq = eqAt >= 0;
  let hits = ENV_LONG.filter((o) => o[0] === name);
  if (hits.length === 0) hits = ENV_LONG.filter((o) => o[0].startsWith(name));
  if (hits.length !== 1) return "exit";
  const [full, takes] = hits[0];
  if (full === "null" || full === "help" || full === "version" || (takes === "no" && eq)) return "exit";
  if (full === "split-string") return "split";
  return takes === "must" ? "value" : "plain";
}

// `env -S STRING` in any spelling at the top of the stack: [the string, words used] or [null, 0].
function splitString(stack) {
  const value = stack[stack.length - 1].value;
  const nxt = stack.length > 1 ? stack[stack.length - 2] : null;
  if (value.startsWith("--") && value.length > 2 && envLong(value) === "split") {
    const eqAt = value.indexOf("=");
    if (eqAt >= 0) return [value.slice(eqAt + 1), 1];
    return nxt !== null && nxt.kind === "w" ? [nxt.value, 2] : ["", 1];
  }
  if (value.startsWith("-") && !value.startsWith("--") && value.length > 1) {
    const [kind, i] = envCluster(value);
    if (kind === "split") {
      if (i < value.length - 1) return [value.slice(i + 1), 1]; // the string is attached
      return nxt !== null && nxt.kind === "w" ? [nxt.value, 2] : ["", 1];
    }
  }
  return [null, 0];
}

const ENV_ESCAPES = { f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "#": "#", '"': '"', "'": "'", $: DOLLAR };
const ENV_SPACE = " \t\n\r\f\v";

// The words `env -S` makes of a string. Throws Syntax where `env` refuses the string.
function envWords(string) {
  if (!string.includes("\\")) return lex(string);
  const words = [];
  let cur = null;
  let quote = "";
  let i = 0;
  const n = string.length;
  while (i < n) {
    const ch = string[i];
    if (ch === "\\") {
      i += 1;
      if (i >= n) throw new Syntax();
      const esc = string[i];
      i += 1;
      if (quote === "'" && esc !== "\\" && esc !== "'") {
        cur.push("\\" + esc); // `\c` and `\_` are plain text inside single quotes
        continue;
      }
      if (esc === "c") {
        if (quote) throw new Syntax();
        break;
      }
      if (esc === "_") {
        if (quote) {
          cur = cur || [];
          cur.push(" ");
        } else if (cur !== null) {
          words.push(cur.join(""));
          cur = null;
        }
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(ENV_ESCAPES, esc)) throw new Syntax();
      cur = cur || [];
      cur.push(ENV_ESCAPES[esc]);
      continue;
    }
    if (quote) {
      if (ch === quote) quote = "";
      else cur.push(ch === "$" ? DOLLAR : ch);
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      cur = cur || [];
    } else if (ENV_SPACE.includes(ch)) {
      if (cur !== null) {
        words.push(cur.join(""));
        cur = null;
      }
    } else if (ch === "#" && cur === null) break;
    else {
      cur = cur || [];
      cur.push(ch === "$" ? DOLLAR : ch);
    }
    i += 1;
  }
  if (quote) throw new Syntax();
  if (cur !== null) words.push(cur.join(""));
  return words.map((w) => new Tok("w", w));
}

// Consume a wrapper's own options from `stack` (the unread words, next word last). Returns false when the wrapper
// only looks something up. `env -S STRING` splits STRING into the words it runs; they are pushed back onto the stack.
function skipWrapper(name, stack) {
  const takes = WRAPPER_VALUE_OPTIONS[name];
  const noexecLong = WRAPPER_NOEXEC_LONG[name] || [];
  const noexecShort = WRAPPER_NOEXEC_SHORT[name] || "";
  while (stack.length) {
    const w = stack[stack.length - 1];
    if (w.kind !== "w") break;
    const value = w.value;
    if (value === "--") {
      stack.pop();
      break;
    }
    if (name === "env" && ASSIGN.test(value)) {
      stack.pop();
      continue;
    }
    if (value.length > 1 && value[0] === "-") {
      const eqAt = value.indexOf("=");
      if (startsOneOf(eqAt < 0 ? value : value.slice(0, eqAt), noexecLong)) return false;
      if (name === "command" && !value.startsWith("--") && (value.includes("v") || value.includes("V"))) return false;
      if (name === "env") {
        if (!value.startsWith("--") && envCluster(value)[0] === "bad") return false; // env exits before it runs anything
        if (value.startsWith("--") && value.length > 2 && envLong(value) === "exit") return false;
        const [string, used] = splitString(stack);
        if (used) {
          const source = used === 2 ? stack[stack.length - 2] : stack[stack.length - 1]; // the string's own word
          const depth = source.depth + 1;
          if (depth > ENV_SPLIT_LIMIT) {
            stopped.atLimit = true;
            return false;
          }
          let lexed;
          try {
            lexed = envWords(peelSplitRun(string));
          } catch (error) {
            if (error instanceof Syntax) return false;
            throw error;
          }
          const anchor = source.at;
          stack.length -= used;
          const made = [];
          for (const t of lexed) {
            const m = t.kind === "w" ? new Tok(t.kind, t.value, t.subs, t.lead) : new Tok("w", t.value);
            m.at = anchor;
            m.depth = depth;
            made.push(m);
          }
          made.reverse();
          for (const m of made) stack.push(m);
          continue;
        }
      }
      if (noexecShort && !value.startsWith("--")) {
        for (const ch of value.slice(1)) {
          if (noexecShort.includes(ch)) return false;
          if (takes.has("-" + ch)) break;
        }
      }
      let consumes = takes.has(value);
      if (name === "env" && value.startsWith("--") && value.length > 2) {
        consumes = envLong(value) === "value" && !value.includes("=");
      }
      if (name === "env" && !consumes && !value.startsWith("--")) {
        for (let i = 1; i < value.length; i++) {
          const ch = value[i];
          if (ch === "u" || ch === "C" || ch === "P") {
            // a value-taking letter at the end of a cluster takes the next word
            consumes = i === value.length - 1;
            break;
          }
        }
      }
      stack.length -= consumes ? Math.min(2, stack.length) : 1;
      continue;
    }
    break;
  }
  if (name === "timeout" && stack.length && stack[stack.length - 1].kind === "w" && DURATION.test(stack[stack.length - 1].value)) {
    stack.pop();
  }
  return true;
}

export const base = (value) => value.slice(value.lastIndexOf("/") + 1);

// [program word, argument words] past assignments, keywords and wrapper words, or null.
export function program(words) {
  const stack = words.slice().reverse(); // the next word is last, so a wrapper never copies the rest
  while (stack.length) {
    const w = stack[stack.length - 1];
    if (w.kind !== "w") return null;
    const value = w.value;
    stack.pop();
    if (ASSIGN.test(value) || KEYWORDS.has(value)) continue;
    const name = base(value);
    if (Object.prototype.hasOwnProperty.call(WRAPPER_VALUE_OPTIONS, name)) {
      if (!skipWrapper(name, stack)) return null;
      continue;
    }
    stack.reverse();
    return [w, stack];
  }
  return null;
}

export const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish"]);
export const PYTHON = /^(?:python|pypy)[0-9.]*$/;

// How a runner segment uses its input: mode is stdin | file | inline | none.
export class Run {
  constructor(mode, operand = null, inline = null) {
    this.mode = mode;
    this.operand = operand;
    this.inline = inline;
  }
}

export function runShell(args) {
  let i = 0;
  const n = args.length;
  let wantInline = false;
  let explicitStdin = false;
  while (i < n) {
    const arg = args[i];
    if (arg.kind !== "w") break;
    const value = arg.value;
    if (value === "--") {
      i += 1;
      break;
    }
    const eqAt = value.indexOf("=");
    if (
      value === "--noexec" || value === "--dump-strings" || value === "--dump-po-strings" ||
      startsOneOf(eqAt < 0 ? value : value.slice(0, eqAt), ["--version", "--help"])
    ) {
      return new Run("none");
    }
    if (value.startsWith("--") && value.length > 2) {
      i += value === "--rcfile" || value === "--init-file" ? 2 : 1;
      continue;
    }
    if (value.length > 1 && (value[0] === "-" || value[0] === "+")) {
      const flags = value.slice(1);
      if (value[0] === "-" && flags.includes("n")) return new Run("none");
      if (flags.includes("c") && value[0] === "-") wantInline = true;
      if (flags.includes("s") && value[0] === "-") explicitStdin = true;
      let taken = 0;
      for (const ch of flags) {
        if (ch === "o" || ch === "O") {
          const option = i + 1 + taken < n ? args[i + 1 + taken] : null;
          if (ch === "o" && value[0] === "-" && option !== null && option.kind === "w" && option.value === "noexec") {
            return new Run("none"); // `-o noexec` reads the commands and runs none
          }
          taken += 1;
        }
      }
      i += 1 + taken;
      continue;
    }
    break;
  }
  if (wantInline) return new Run("inline", null, i < n && args[i].kind === "w" ? args[i] : null);
  if (explicitStdin || i >= n || (args[i].kind === "w" && args[i].value === "-")) return new Run("stdin");
  return new Run("file", args[i]);
}

// The last redirection that replaces standard input: [operator, target] or null.
export function stdinRedirect(segment) {
  let found = null;
  for (const [operator, target] of segment.redirs) {
    const [fd, op] = redirectParts(operator);
    if (fd !== "" && fd !== "0") continue;
    if (["<", "<<", "<<-", "<<<", "<&", "<>"].includes(op)) found = [op, target];
  }
  return found;
}

const STDOUT_NAMES = new Set(["/dev/stdout", "/dev/fd/1", "/proc/self/fd/1"]);

// Every target that takes standard output off the pipe, in order ("-" for a process substitution).
export function stdoutRedirects(segment) {
  const found = [];
  for (const [operator, target] of segment.redirs) {
    if (target === null || (target.kind !== "w" && target.kind !== "ps")) continue;
    const [fd, op] = redirectParts(operator);
    if ((op.startsWith("&>") && !fd) || ([">", ">>", ">|", ">&"].includes(op) && (fd === "" || fd === "1"))) {
      if (target.kind === "ps") found.push("-");
      else if (STDOUT_NAMES.has(target.value) || (op === ">&" && target.value === "1")) continue;
      else found.push(target.value);
    }
  }
  return found;
}
