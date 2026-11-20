import { pinRx, lowerPinned, nfkcPinned } from "./pinned.js";
// A lexer for Python source, as the interpreter's own tokenizer reads it (3.14), for the reader of Python code.
// The source is read as the interpreter reads a string: line ends are one newline, a last line with no newline gets one,
// indentation uses the tab and form feed rules, and names, numbers and strings follow the same shapes.
//
// Strings with an `f` or `t` prefix are read by a hook the parser installs (setFStringHook): their replacement fields
// hold expressions, so the end of the string is known only after the fields are read.

export class PySyntax extends Error {}
export const fail = (message) => {
  throw new PySyntax(message);
};

export const KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif",
  "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass",
  "raise", "return", "try", "while", "with", "yield",
]);

const MAX_INDENT = 100;
const MAX_LEVEL = 200;
const MAX_DIGITS = 4300;

// The source as the tokenizer gets it: newlines are \n, and the last line ends in one.
export class Source {
  constructor(raw) {
    let text = raw.replace(/\r\n?/g, "\n");
    if (text.length && !text.endsWith("\n")) text += "\n";
    this.text = text;
    this.starts = [0];
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) this.starts.push(i + 1);
  }
  // The 1-based line of offset `at`.
  line(at) {
    const starts = this.starts;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
}

let fstringHook = null;
export const setFStringHook = (hook) => {
  fstringHook = hook;
};

const IDENT_RUN = /[A-Za-z0-9_\u0080-\u{10FFFF}]+/uy;
const IDENT_OK = pinRx(String.raw`^[\p{XID_Start}_]\p{XID_Continue}*$`, "u");
const PREFIXES = new Set(["r", "u", "b", "f", "t", "br", "rb", "fr", "rf", "tr", "rt"]);
const isDigit = (c) => c >= "0" && c <= "9";
const isHex = (c) => (c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
const isIdentChar = (c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_";

// A name token's text: checked as an identifier and normalised (NFKC) when it is not ASCII.
export function identifier(run) {
  if (/^[\x00-\x7f]*$/.test(run)) return run;
  if (!IDENT_OK.test(run)) fail("invalid character in identifier");
  return nfkcPinned(run);
}

const THREE = new Set(["**=", "//=", ">>=", "<<=", "..."]);
const TWO = new Set(["->", ":=", "!=", "==", "<=", ">=", "<<", ">>", "**", "//", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "@=", "<>"]);
const ONE = new Set("+-*/%@&|^~<>()[]{},:.;=");
const CLOSE = { ")": "(", "]": "[", "}": "{" };

export class Lexer {
  // mode "module": the whole source. mode "field": the expression of an f-string replacement field, from `pos`.
  constructor(source, pos = 0, mode = "module") {
    this.source = source;
    this.src = source.text;
    this.pos = pos;
    this.mode = mode;
    this.stack = []; // open brackets
    this.atBol = mode === "module";
    this.indents = [0];
    this.altIndents = [0];
    this.pending = []; // INDENT and DEDENT tokens to give out
    this.done = false;
  }

  token(t, v, at, end) {
    return { t, v, at, end, line: this.source.line(at) };
  }

  // The indentation of the line at `pos`, and the tokens it makes.
  indentation() {
    const s = this.src;
    let col = 0;
    let alt = 0;
    let cont = 0;
    let i = this.pos;
    for (;;) {
      const c = s[i];
      if (c === " ") {
        col += 1;
        alt += 1;
      } else if (c === "\t") {
        col = (Math.floor(col / 8) + 1) * 8;
        alt += 1;
      } else if (c === "\x0c") {
        col = 0;
        alt = 0;
      } else if (c === "\\") {
        cont = cont || col;
        if (s[i + 1] !== "\n") fail("unexpected character after line continuation character");
        if (i + 2 >= s.length) fail("unexpected EOF while parsing");
        i += 1; // the newline is taken with the loop's step below
        i += 1;
        continue;
      } else break;
      i += 1;
    }
    this.pos = i;
    const c = s[i];
    if (c === "#" || c === "\n") {
      // a line with no code on it makes no tokens
      if (c === "#") while (this.pos < s.length && s[this.pos] !== "\n") this.pos += 1;
      this.pos += 1;
      return false;
    }
    if (i >= s.length) return false;
    if (cont) {
      col = cont;
      alt = cont;
    }
    const top = this.indents[this.indents.length - 1];
    const altTop = this.altIndents[this.altIndents.length - 1];
    if (col === top) {
      if (alt !== altTop) fail("inconsistent use of tabs and spaces in indentation");
    } else if (col > top) {
      if (this.indents.length >= MAX_INDENT) fail("too many levels of indentation");
      if (alt <= altTop) fail("inconsistent use of tabs and spaces in indentation");
      this.indents.push(col);
      this.altIndents.push(alt);
      this.pending.push(this.token("INDENT", "", i, i));
    } else {
      while (this.indents.length > 1 && col < this.indents[this.indents.length - 1]) {
        this.indents.pop();
        this.altIndents.pop();
        this.pending.push(this.token("DEDENT", "", i, i));
      }
      if (col !== this.indents[this.indents.length - 1]) fail("unindent does not match any outer indentation level");
      if (alt !== this.altIndents[this.altIndents.length - 1]) fail("inconsistent use of tabs and spaces in indentation");
    }
    return true;
  }

  // A lexing error stays: the parser may back up and try another reading, which meets the same error again.
  next() {
    if (this.error) throw this.error;
    if (this.pending.length) return this.pending.shift();
    try {
      return this.lex();
    } catch (error) {
      this.error = error;
      throw error;
    }
  }

  lex() {
    const s = this.src;
    for (;;) {
      if (this.atBol && this.stack.length === 0) {
        if (this.pos >= s.length) break;
        this.atBol = false;
        if (!this.indentation()) {
          this.atBol = true;
          continue;
        }
        if (this.pending.length) return this.pending.shift();
      } else this.atBol = false;
      // skip blanks
      while (this.pos < s.length && (s[this.pos] === " " || s[this.pos] === "\t" || s[this.pos] === "\x0c")) this.pos += 1;
      if (this.pos >= s.length) break;
      const at = this.pos;
      const c = s[at];
      if (c === "#") {
        while (this.pos < s.length && s[this.pos] !== "\n") this.pos += 1;
        continue;
      }
      if (c === "\n") {
        this.pos += 1;
        if (this.mode === "field" || this.stack.length > 0) continue;
        this.atBol = true;
        return this.token("NEWLINE", "\n", at, at + 1);
      }
      if (c === "\\") {
        if (s[at + 1] !== "\n") fail("unexpected character after line continuation character");
        if (at + 2 >= s.length) fail("unexpected EOF while parsing");
        this.pos += 2;
        continue;
      }
      if (c === "\0") fail("source code string cannot contain null bytes");
      // numbers
      if (isDigit(c) || (c === "." && isDigit(s[at + 1] || ""))) return this.number(at);
      // names and strings
      if (isIdentChar(c) || c >= "\u0080") {
        IDENT_RUN.lastIndex = at;
        const run = IDENT_RUN.exec(s)[0];
        const quote = s[at + run.length];
        if ((quote === '"' || quote === "'") && PREFIXES.has(lowerPinned(run))) return this.string(at, run);
        this.pos = at + run.length;
        return this.token("NAME", identifier(run), at, this.pos);
      }
      if (c === '"' || c === "'") return this.string(at, "");
      // operators
      const three = s.slice(at, at + 3);
      let op;
      if (THREE.has(three)) op = three;
      else {
        const two = s.slice(at, at + 2);
        if (TWO.has(two)) op = two;
        else if (ONE.has(c) || c === "!") op = c;
        else fail("invalid character");
      }
      if (this.mode === "field" && this.stack.length === 0) {
        if (c === ":") op = ":";
        else if (c === "!" && s[at + 1] !== "=") op = "!";
        else if (c === "}") {
          this.pos = at + 1;
          return this.token("OP", "}", at, this.pos);
        }
      }
      if (op === "!" && !(this.mode === "field" && this.stack.length === 0)) fail("invalid syntax");
      if (op === "(" || op === "[" || op === "{") {
        if (this.stack.length >= MAX_LEVEL) fail("too many nested parentheses");
        this.stack.push(op);
      } else if (op === ")" || op === "]" || op === "}") {
        if (!this.stack.length) fail("unmatched bracket");
        if (this.stack.pop() !== CLOSE[op]) fail("closing bracket does not match");
      }
      this.pos = at + op.length;
      return this.token("OP", op, at, this.pos);
    }
    // end of the text
    if (this.mode === "field") {
      this.pos = s.length;
      return this.token("END", "", s.length, s.length);
    }
    if (this.stack.length) fail("bracket was never closed");
    if (!this.done) {
      this.done = true;
      while (this.indents.length > 1) {
        this.indents.pop();
        this.altIndents.pop();
        this.pending.push(this.token("DEDENT", "", s.length, s.length));
      }
      this.pending.push(this.token("END", "", s.length, s.length));
      return this.pending.shift();
    }
    return this.token("END", "", s.length, s.length);
  }

  // The end of a number literal, which must not run into a name unless that name is a keyword that can follow one.
  verifyEnd(i, kind) {
    const s = this.src;
    const c = s[i] || "";
    let r = false;
    if (c === "a") r = s.startsWith("nd", i + 1);
    else if (c === "e") r = s.startsWith("lse", i + 1);
    else if (c === "f") r = s.startsWith("or", i + 1);
    else if (c === "i") r = "fns".includes(s[i + 1] || "-") && (s[i + 1] || "") !== "";
    else if (c === "o") r = s.startsWith("r", i + 1);
    else if (c === "n") r = s.startsWith("ot", i + 1);
    if (!r && c !== "" && c < "\u0080" && isIdentChar(c)) fail(`invalid ${kind} literal`);
  }

  // The digits (and single underscores between them) from `i`; returns the index after them.
  digitsTail(i, isDigitFn = isDigit, kind = "decimal") {
    const s = this.src;
    for (;;) {
      while (isDigitFn(s[i] || "")) i += 1;
      if (s[i] !== "_") return i;
      i += 1;
      if (!isDigitFn(s[i] || "")) fail(`invalid ${kind} literal`);
    }
  }

  number(at) {
    const s = this.src;
    let i = at;
    let kind = "int";
    let text;
    const finish = (end, k) => {
      this.pos = end;
      return { ...this.token("NUM", s.slice(at, end), at, end), kind: k };
    };
    if (s[i] === "0" && "xXoObB".includes(s[i + 1] || "-") && s[i + 1] !== undefined) {
      const base = lowerPinned(s[i + 1]);
      const ok = base === "x" ? isHex : base === "o" ? (c) => c >= "0" && c <= "7" : (c) => c === "0" || c === "1";
      const name = base === "x" ? "hexadecimal" : base === "o" ? "octal" : "binary";
      i += 2;
      if (s[i] === "_") i += 1;
      if (!ok(s[i] || "")) {
        if (isDigit(s[i] || "") && base !== "x") fail(`invalid digit in ${name} literal`);
        fail(`invalid ${name} literal`);
      }
      i = this.digitsTail(i, ok, name);
      if (isDigit(s[i] || "") && base !== "x") fail(`invalid digit in ${name} literal`);
      this.verifyEnd(i, name);
      return finish(i, "int");
    }
    let nonzero = false;
    if (s[i] === "0") {
      // zeros, then maybe a fraction, an exponent, an imaginary mark; digits after zeros are an old octal
      for (;;) {
        while (s[i] === "0") i += 1;
        if (s[i] !== "_") break;
        i += 1;
        if (!isDigit(s[i] || "")) fail("invalid decimal literal");
      }
      if (isDigit(s[i] || "")) {
        nonzero = true;
        i = this.digitsTail(i);
      }
      if (s[i] !== "." && s[i] !== "e" && s[i] !== "E" && s[i] !== "j" && s[i] !== "J") {
        if (nonzero) fail("leading zeros in decimal integer literals are not permitted");
        this.verifyEnd(i, "decimal");
        return finish(i, "int");
      }
    } else if (s[i] !== ".") i = this.digitsTail(i);
    if (s[i] === ".") {
      kind = "float";
      i += 1;
      if (isDigit(s[i] || "")) i = this.digitsTail(i);
    }
    if (s[i] === "e" || s[i] === "E") {
      let j = i + 1;
      if (s[j] === "+" || s[j] === "-") j += 1;
      if (!isDigit(s[j] || "")) {
        // `1else`: the number ends before the `e` when a keyword follows
        this.verifyEnd(i, "decimal");
        return finish(i, kind);
      }
      kind = "float";
      i = this.digitsTail(j);
    }
    if (s[i] === "j" || s[i] === "J") {
      i += 1;
      this.verifyEnd(i, "imaginary");
      return finish(i, "complex");
    }
    this.verifyEnd(i, "decimal");
    text = s.slice(at, i);
    if (kind === "int" && text.replace(/_/g, "").length > MAX_DIGITS) fail("Exceeds the limit for integer string conversion");
    return finish(i, kind);
  }

  string(at, prefix) {
    const s = this.src;
    const quoteAt = at + prefix.length;
    const quote = s[quoteAt];
    const triple = s[quoteAt + 1] === quote && s[quoteAt + 2] === quote;
    const lower = lowerPinned(prefix);
    const raw = lower.includes("r");
    const bytes = lower.includes("b");
    const body = quoteAt + (triple ? 3 : 1);
    if (lower.includes("f") || lower.includes("t")) {
      const made = fstringHook(this.source, body, quote, triple, raw, lower.includes("t"));
      this.pos = made.end;
      return { ...this.token("STR", "", at, made.end), prefix: lower, parts: made.parts, template: lower.includes("t"), bytes: false };
    }
    let i = body;
    for (;;) {
      if (i >= s.length) fail("unterminated string literal");
      const c = s[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "\n" && !triple) fail("unterminated string literal");
      if (c === quote) {
        if (!triple) break;
        if (s[i + 1] === quote && s[i + 2] === quote) break;
      }
      i += 1;
    }
    const content = s.slice(body, i);
    const end = i + (triple ? 3 : 1);
    this.pos = end;
    return { ...this.token("STR", "", at, end), prefix: lower, value: decode(content, raw, bytes), bytes, parts: null };
  }
}

const SIMPLE = { "\n": "", "\\": "\\", "'": "'", '"': '"', a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };

// The value of the text of a string literal: backslash escapes read (not when raw). A bytes literal holds ASCII only
// and has no \N, \u or \U escapes.
export function decode(content, raw, bytes) {
  if (bytes && /[^\x00-\x7f]/.test(content)) fail("bytes can only contain ASCII literal characters");
  if (raw || !content.includes("\\")) return bytes ? { bytes: content } : content;
  let out = "";
  let i = 0;
  const n = content.length;
  while (i < n) {
    const c = content[i];
    if (c !== "\\") {
      out += c;
      i += 1;
      continue;
    }
    const e = content[i + 1];
    i += 2;
    if (e === undefined) {
      out += "\\";
      break;
    }
    if (e in SIMPLE) out += SIMPLE[e];
    else if (e >= "0" && e <= "7") {
      let digits = e;
      while (digits.length < 3 && content[i] >= "0" && content[i] <= "7") digits += content[i++];
      out += String.fromCharCode(parseInt(digits, 8));
    } else if (e === "x") {
      const h = content.slice(i, i + 2);
      if (!/^[0-9a-fA-F]{2}$/.test(h)) fail("truncated \\xXX escape");
      out += String.fromCharCode(parseInt(h, 16));
      i += 2;
    } else if (!bytes && (e === "u" || e === "U")) {
      const width = e === "u" ? 4 : 8;
      const h = content.slice(i, i + width);
      if (h.length !== width || !/^[0-9a-fA-F]+$/.test(h)) fail("truncated unicode escape");
      const cp = parseInt(h, 16);
      if (cp > 0x10ffff) fail("illegal Unicode character");
      out += String.fromCodePoint(cp);
      i += width;
    } else if (!bytes && e === "N") {
      if (content[i] !== "{") fail("malformed \\N character escape");
      const close = content.indexOf("}", i);
      if (close < 0 || close === i + 1) fail("malformed \\N character escape");
      if (!/^[A-Za-z0-9 -]+$/.test(content.slice(i + 1, close))) fail("unknown Unicode character name");
      out += "�";
      i = close + 1;
    } else out += "\\" + e;
  }
  return bytes ? { bytes: out } : out;
}
