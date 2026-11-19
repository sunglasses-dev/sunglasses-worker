// GLS-STRUCT-005: Python code that shows or sends every environment variable. The text is read as a Python program
// (the whole text, or each fenced python block on its own), and the reader follows what `os.environ` stands for through
// the tree: copies, views, loops, comprehensions and formats, to the calls that print, log, write or send it.
import { PySyntax, parsePython, walk, children } from "./py_parser.js";
import { cpHead, pySplitlines, pyStrip, PY_SPACE } from "./py_text.js";
import { fencedBlocks } from "./registry_redirect.js";

const BUILTINS = new Set([
  "print", "open", "dict", "list", "tuple", "sorted", "str", "repr", "ascii", "format", "map", "any", "all", "sum", "min",
  "max", "set", "frozenset", "exit", "quit",
]);
const BARE_MODULES = new Set(["os", "sys", "json", "logging", "requests", "httpx", "pprint"]);
const MAX_NAMES = 256; // environment-bound names tracked in one scope
const EXIT_CALLS = new Set(["sys.exit", "os._exit", "builtins.exit", "builtins.quit"]);
const LOG_HIGH = new Map([["warning", 30], ["warn", 30], ["error", 40], ["exception", 40], ["critical", 50], ["fatal", 50]]);
const LOG_LOW = new Map([["debug", 10], ["info", 20]]);
const LOG_NUMBERS = new Map([
  ["DEBUG", 10], ["INFO", 20], ["WARNING", 30], ["WARN", 30], ["ERROR", 40], ["CRITICAL", 50], ["FATAL", 50], ["NOTSET", 0],
]);
const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "request"]);
const HTTP_MODULES = new Set(["requests", "httpx"]);
const PERCENT = /%(\([^)]*\))?([#0\- +]*)(\*|\p{Nd}+)?(?:\.(\*|\p{Nd}*))?[hlL]?([a-zA-Z%])/uy;
const WIDTH_ONLY = /^[<>^]?\p{Nd}{0,4}s?\n?$/u;
const WRITE_MODE = /^[rwax+]*[wax+][rwax+]*\n?$/;
const ENV_WORD = /(?<![\p{L}\p{N}_])environ(?![\p{L}\p{N}_])/u;
const PYTHON_TAG = /^(?:python3?|py)(?![\p{L}\p{N}_+-])/iu;
const SPACE_ONLY = new RegExp(`^[${PY_SPACE}]+$`);

const EXPRESSIONS = new Set([
  "BoolOp", "NamedExpr", "BinOp", "UnaryOp", "Lambda", "IfExp", "Dict", "Set", "ListComp", "SetComp", "DictComp",
  "GeneratorExp", "Await", "Yield", "YieldFrom", "Compare", "Call", "FormattedValue", "Interpolation", "JoinedStr",
  "TemplateStr", "Constant", "Attribute", "Subscript", "Starred", "Name", "List", "Tuple", "Slice",
]);
const isExpr = (node) => EXPRESSIONS.has(node._);
const isDef = (node) => node._ === "FunctionDef" || node._ === "AsyncFunctionDef" || node._ === "ClassDef";
const isLoop = (node) => node._ === "For" || node._ === "AsyncFor";
const isName = (node) => node !== null && node !== undefined && node._ === "Name";
const isStarred = (node) => node._ === "Starred";

// ---------------------------------------------------------------------------------------------- constants

const isConst = (node) => node !== null && node !== undefined && node._ === "Constant";
const isText = (node) => isConst(node) && node.value.k === "str";
const isNoneConst = (node) => isConst(node) && node.value.k === "None";

// bool(value) for the value of a constant.
function truthy(value) {
  switch (value.k) {
    case "None": return false;
    case "bool": return value.v;
    case "str":
    case "bytes": return value.v.length > 0;
    case "int": return value.v !== 0n;
    case "float":
    case "complex": return value.v !== 0;
    default: return true;
  }
}

// value == 1
const equalsOne = (value) =>
  (value.k === "int" && value.v === 1n) || (value.k === "bool" && value.v === true) || (value.k === "float" && value.v === 1);

// True / False for a test that is a constant, else null; no name is taken for a constant.
function truth(test) {
  if (isConst(test)) return truthy(test.value);
  if (test._ === "UnaryOp" && test.op === "Not") {
    const inner = truth(test.operand);
    return inner === null ? null : !inner;
  }
  return null;
}

// A request body that is absent, `None`, another falsy constant or an empty list, tuple, set or dict.
function emptyBody(node) {
  if (node === null || node === undefined) return true;
  if (node._ === "List" || node._ === "Tuple" || node._ === "Set") return node.elts.length === 0;
  if (node._ === "Dict") return node.keys.length === 0;
  return isConst(node) && !truthy(node.value);
}

// Whether the expression or statement mentions one of `names`.
function countLoads(node, names) {
  for (const child of walk(node)) if (child._ === "Name" && names.has(child.id)) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------- formats

// The conversions of a `%` format as (shows the argument) flags, or null for a format the reader does not follow.
function percentSlots(fmt) {
  const slots = [];
  let position = 0;
  for (;;) {
    position = fmt.indexOf("%", position);
    if (position < 0) return slots;
    PERCENT.lastIndex = position;
    const found = PERCENT.exec(fmt);
    if (found === null) return null;
    position = PERCENT.lastIndex;
    const [, named, , width, precision, conv] = found;
    if (conv === "%") continue;
    if (named !== undefined || width === "*" || precision === "*") return null;
    slots.push("sra".includes(conv) && precision === undefined);
  }
}

class FormatError extends Error {}

// The pieces of a `str.format` format, as string.Formatter().parse gives them: [literal, field, spec, conversion],
// where field, spec and conversion are null for a literal with no field after it.
function formatterParse(s) {
  const out = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const start = i;
    let c = "";
    let markup = false;
    while (i < n) {
      c = s[i++];
      if (c === "{" || c === "}") {
        markup = true;
        break;
      }
    }
    const atEnd = i >= n;
    let len = i - start;
    if (c === "}" && markup && (atEnd || s[i] !== "}")) throw new FormatError("Single '}' encountered in format string");
    if (atEnd && c === "{" && markup) throw new FormatError("Single '{' encountered in format string");
    if (!atEnd && markup) {
      if (c === s[i]) {
        i += 1; // an escaped brace is a literal
        markup = false;
      } else len -= 1;
    }
    const literal = s.slice(start, start + len);
    if (!markup) {
      out.push([literal, null, null, null]);
      continue;
    }
    // the field
    let c2 = "";
    const nameStart = i;
    while (i < n) {
      c2 = s[i++];
      if (c2 === "{") throw new FormatError("unexpected '{' in field name");
      if (c2 === "[") {
        while (i < n && s[i] !== "]") i += 1;
        continue;
      }
      if (c2 === "}" || c2 === ":" || c2 === "!") break;
    }
    const field = s.slice(nameStart, i - 1);
    let conversion = null;
    let spec = "";
    if (c2 === "!" || c2 === ":") {
      let done = false;
      if (c2 === "!") {
        if (i >= n) throw new FormatError("end of string while looking for conversion specifier");
        conversion = s[i++];
        if (i < n) {
          const c3 = s[i++];
          if (c3 === "}") done = true;
          else if (c3 !== ":") throw new FormatError("expected ':' after conversion specifier");
        }
      }
      if (!done) {
        const specStart = i;
        let count = 1;
        let closed = false;
        while (i < n) {
          const c4 = s[i++];
          if (c4 === "{") count += 1;
          else if (c4 === "}") {
            count -= 1;
            if (count === 0) {
              spec = s.slice(specStart, i - 1);
              closed = true;
              break;
            }
          }
        }
        if (!closed) throw new FormatError("unmatched '{' in format spec");
      }
    } else if (c2 !== "}") throw new FormatError("expected '}' before end of string");
    out.push([literal, field, spec, conversion]);
  }
  return out;
}

// The fields of a `str.format` format as [key, shows the argument, needs a string], key an index or a keyword, or null
// for a format the reader does not follow.
function braceSlots(fmt) {
  let parts;
  try {
    parts = formatterParse(fmt);
  } catch (error) {
    if (error instanceof FormatError) return null;
    throw error;
  }
  const slots = [];
  let auto = 0;
  let explicit = false;
  for (const [, field, spec, conv] of parts) {
    if (field === null) continue;
    if (field.includes(".") || field.includes("[") || (conv !== null && conv !== "s" && conv !== "r" && conv !== "a") || spec.includes("{")) {
      return null;
    }
    let key;
    if (field === "") key = auto++;
    else if (/^[0-9]+$/.test(field)) {
      if (field.length > 9) return null; // an index no argument list reaches
      key = Number(field);
      explicit = true;
    } else key = field;
    slots.push([key, WIDTH_ONLY.test(spec), spec !== "" && conv === null]);
  }
  if (auto && explicit) return null;
  return slots;
}

// ---------------------------------------------------------------------------------------------- the kinds

// What a mapping, view or list made from `os.environ` is. `shape` is map, items, values or keys; `concrete` is a real
// dict or list; `onEnv` says the object or view stands on `os.environ`.
class Kind {
  constructor(shape, concrete, onEnv) {
    this.shape = shape;
    this.concrete = concrete;
    this.onEnv = onEnv;
  }
  inText() {
    if (this.shape === "keys") return this.onEnv && !this.concrete;
    return true;
  }
  inIteration() {
    return this.shape === "items" || this.shape === "values";
  }
  inJson() {
    return this.concrete && (this.shape === "map" || this.shape === "items" || this.shape === "values");
  }
}

const EMPTY = new Set();

// Names that hold the environment's values in the loop or comprehension being read.
class Ctx {
  constructor(keys = EMPTY, values = EMPTY, pairs = EMPTY) {
    this.keys = keys;
    this.values = values;
    this.pairs = pairs;
  }
  live() {
    return this.keys.size > 0 || this.values.size > 0 || this.pairs.size > 0;
  }
  names() {
    if (!this.live()) return EMPTY;
    return new Set([...this.keys, ...this.values, ...this.pairs]);
  }
}
const NO_CTX = new Ctx();

const plus = (set, name) => new Set(set).add(name);
const minus = (set, gone) => {
  const out = new Set(set);
  for (const name of gone) out.delete(name);
  return out;
};

class Found extends Error {
  constructor(evidence) {
    super("found");
    this.evidence = evidence;
  }
}

// ---------------------------------------------------------------------------------------------- the reader

class EnvironmentReader {
  constructor(tree) {
    this.tree = tree;
    this.targets = new Map(); // imported name -> {what it stands for}
    this.stores = new Map(); // name -> times it is bound by anything but an import
    this.files = new Map(); // name -> times it is bound to a file opened for writing
    this.loggers = new Set(); // names bound once to logging.getLogger(...)
    this.sessions = new Map(); // names bound once to a requests session or an httpx client
    this.levels = []; // logging levels set anywhere: numbers, null when not a literal
    this.loggingOff = false;
    this.exits = new Map(); // loop -> the loop body can leave early
    this.replaced = false; // os.environ is assigned to in the file
    this.elseMemo = new Map();
    this.continues = null;
    this.collect();
  }

  // ------------------------------------------------------------------ name facts

  store(name) {
    this.stores.set(name, (this.stores.get(name) || 0) + 1);
  }

  collect() {
    const all = walk(this.tree);
    for (const node of all) {
      switch (node._) {
        case "Import":
          for (const alias of node.names) {
            const name = alias.asname || alias.name.split(".")[0];
            const what = alias.asname ? alias.name : alias.name.split(".")[0];
            this.target(name, what);
          }
          break;
        case "ImportFrom":
          for (const alias of node.names) {
            const name = alias.asname || alias.name;
            const what = node.module && !node.level ? `${node.module}.${alias.name}` : "?";
            this.target(name, what);
          }
          break;
        case "Name":
          if (node.ctx === "Store" || node.ctx === "Del") this.store(node.id);
          break;
        case "FunctionDef":
        case "AsyncFunctionDef":
        case "ClassDef":
          this.store(node.name);
          break;
        case "arg":
          this.store(node.arg);
          break;
        case "ExceptHandler":
          if (node.name) this.store(node.name);
          break;
        case "MatchAs":
        case "MatchStar":
          if (node.name) this.store(node.name);
          break;
        case "MatchMapping":
          if (node.rest) this.store(node.rest);
          break;
        default:
      }
    }
    const calls = [];
    for (const node of all) {
      if (node._ === "Assign" && node.targets.length === 1 && isName(node.targets[0])) {
        this.noteBinding(node.targets[0].id, node.value);
      } else if (node._ === "With" || node._ === "AsyncWith") {
        for (const item of node.items) if (isName(item.optional_vars)) this.noteBinding(item.optional_vars.id, item.context_expr);
      } else if (node._ === "Call") calls.push(node);
      else if (node._ === "Attribute" && (node.ctx === "Store" || node.ctx === "Del") && this.qual(node) === "os.environ") {
        this.replaced = true; // the program binds os.environ to something of its own
      }
    }
    for (const call of calls) this.noteLoggingCall(call);
    this.noteExits(all);
  }

  target(name, what) {
    let set = this.targets.get(name);
    if (set === undefined) this.targets.set(name, (set = new Set()));
    set.add(what);
  }

  noteBinding(name, value) {
    if (this.openedForWriting(value)) this.files.set(name, (this.files.get(name) || 0) + 1);
    else if (value._ === "Call") {
      const made = this.qual(value.func);
      if (made === "logging.getLogger") this.loggers.add(name);
      else if (made === "requests.Session" || made === "requests.session" || made === "httpx.Client") {
        this.sessions.set(name, made.split(".")[0]);
      }
    }
  }

  noteLoggingCall(call) {
    const made = this.qual(call.func);
    if (made === "logging.disable") this.loggingOff = true;
    else if (made === "logging.basicConfig") {
      for (const keyword of call.keywords) if (keyword.arg === "level") this.levels.push(this.level(keyword.value));
    } else if (call.func._ === "Attribute" && call.func.attr === "setLevel" && call.args.length && this.isLogger(call.func.value)) {
      this.levels.push(this.level(call.args[0]));
    }
  }

  // A logger the file made with `getLogger` (or the root logger), not some object with a `setLevel`.
  isLogger(node) {
    if (node._ === "Call") return this.qual(node.func) === "logging.getLogger";
    if (node._ === "Name") return this.boundOnce(node, this.loggers);
    return this.qual(node) === "logging.root";
  }

  level(node) {
    if (isConst(node)) {
      if (node.value.k === "int") return node.value.v;
      if (node.value.k === "str") {
        const found = LOG_NUMBERS.get(node.value.v.toUpperCase());
        return found === undefined ? null : found;
      }
    }
    const made = this.qual(node);
    if (made && made.startsWith("logging.")) {
      const found = LOG_NUMBERS.get(made.split(".").pop());
      return found === undefined ? null : found;
    }
    return null;
  }

  // Whether the `else` arm of a loop can run: never after `while <true>`, and never after a `for` over a non-empty
  // literal whose body always leaves with no `continue` in it.
  elseRuns(node) {
    if (!node.orelse.length) return true;
    let runs = this.elseMemo.get(node);
    if (runs === undefined) {
      runs = this.elseDecision(node);
      this.elseMemo.set(node, runs);
    }
    return runs;
  }

  elseDecision(node) {
    if (node._ === "While") return truth(node.test) !== true;
    const source = node.iter;
    if (
      (source._ === "List" || source._ === "Tuple" || source._ === "Set") &&
      source.elts.length &&
      !source.elts.some(isStarred) &&
      node.body.some((s) => s._ === "Break" || s._ === "Return" || s._ === "Raise")
    ) {
      return this.withContinue().has(node);
    }
    return true;
  }

  // The nodes with a `continue` somewhere below them, from one pass over the tree.
  withContinue() {
    if (this.continues === null) {
      const order = walk(this.tree);
      const parent = new Map();
      for (const node of order) for (const child of children(node)) parent.set(child, node);
      const found = new Set();
      for (let i = order.length - 1; i >= 0; i--) {
        const node = order[i];
        if (node._ === "Continue" || found.has(node)) {
          found.add(node);
          const above = parent.get(node);
          if (above !== undefined) found.add(above);
        }
      }
      this.continues = found;
    }
    return this.continues;
  }

  // Whether each `for` body can leave the loop early or skip an item (a filter).
  noteExits(all) {
    for (const node of all) if (isLoop(node)) this.exits.set(node, this.leaves(node.body, false));
  }

  // Whether the statements can end the loop they sit in, or skip the rest of an item: a `return`, a `raise`, an exit
  // call, or a `break` / `continue` that is not a nested loop's own. A branch that never runs does not count, and a
  // nested function or class is another scope.
  leaves(stmts, inner) {
    for (const node of stmts) {
      if (isDef(node)) continue;
      if (node._ === "Return" || node._ === "Raise") return true;
      if (node._ === "Break" || node._ === "Continue") {
        if (!inner) return true;
        continue;
      }
      if (node._ === "Expr" && node.value._ === "Call") {
        if (EXIT_CALLS.has(this.qual(node.value.func))) return true;
        continue;
      }
      if (isLoop(node) || node._ === "While") {
        const live = !(node._ === "While" && truth(node.test) === false);
        if ((live && this.leaves(node.body, true)) || (this.elseRuns(node) && this.leaves(node.orelse, inner))) return true;
        continue;
      }
      if (node._ === "If") {
        const t = truth(node.test);
        if ((t !== false && this.leaves(node.body, inner)) || (t !== true && this.leaves(node.orelse, inner))) return true;
        continue;
      }
      for (const group of [node.body, node.orelse, node.finalbody]) {
        if (Array.isArray(group) && this.leaves(group, inner)) return true;
      }
      for (const group of [node.handlers, node.cases]) {
        if (!group) continue;
        for (const child of group) {
          if (child.guard !== undefined && child.guard !== null && truth(child.guard) === false) continue;
          if (this.leaves(child.body, inner)) return true;
        }
      }
    }
    return false;
  }

  // The dotted name a Name or Attribute chain stands for, or null.
  qual(node) {
    if (node === null || node === undefined) return null;
    if (node._ === "Name") {
      const whats = this.targets.get(node.id);
      if (whats !== undefined) {
        if (whats.size === 1 && !this.stores.has(node.id)) return whats.values().next().value;
        return null;
      }
      if (BUILTINS.has(node.id) && !this.stores.has(node.id)) return `builtins.${node.id}`;
      if (BARE_MODULES.has(node.id) && !this.stores.has(node.id)) return node.id; // a fragment that leaves out its import
      return null;
    }
    if (node._ === "Attribute") {
      const base = this.qual(node.value);
      return base ? `${base}.${node.attr}` : null;
    }
    return null;
  }

  openedForWriting(node) {
    if (!(node._ === "Call" && this.qual(node.func) === "builtins.open" && node.args.length)) return false;
    let mode = null;
    if (node.args.length > 1) mode = node.args[1];
    else {
      const found = node.keywords.find((k) => k.arg === "mode");
      mode = found === undefined ? null : found.value;
    }
    if (!isText(mode)) return false;
    if (mode.value.v.includes("b") || !WRITE_MODE.test(mode.value.v)) return false;
    const target = node.args[0];
    if (isText(target) && target.value.v === "/dev/null") return false;
    return this.qual(target) !== "os.devnull";
  }

  // ------------------------------------------------------------------ what the environment is

  // The Kind of an expression made from `os.environ`, or null.
  env(node) {
    if (node._ === "Name" || node._ === "Attribute") {
      return this.qual(node) === "os.environ" && !this.replaced ? new Kind("map", false, true) : null;
    }
    if (node._ === "Dict") {
      for (let i = 0; i < node.keys.length; i++) {
        if (node.keys[i] === null) {
          const inner = this.env(node.values[i]);
          if (inner !== null && inner.shape === "map") return new Kind("map", true, false);
        }
      }
      return null;
    }
    if (node._ !== "Call") return null;
    const func = node.func;
    if (func._ === "Attribute" && !node.keywords.length) {
      const inner = this.env(func.value);
      if (inner !== null && inner.shape === "map" && !node.args.length) {
        if (func.attr === "copy") return new Kind("map", true, false);
        if (func.attr === "items" || func.attr === "values" || func.attr === "keys") return new Kind(func.attr, false, inner.onEnv);
      }
      return null;
    }
    const made = this.qual(func);
    if (made === "builtins.dict" && node.args.length === 1 && !isStarred(node.args[0])) {
      const inner = this.env(node.args[0]);
      if (inner !== null && (inner.shape === "map" || inner.shape === "items")) return new Kind("map", true, false);
    }
    if (
      (made === "builtins.list" || made === "builtins.tuple" || made === "builtins.sorted") &&
      node.args.length &&
      !isStarred(node.args[0]) &&
      (made === "builtins.sorted" || node.args.length === 1)
    ) {
      if (made !== "builtins.sorted" && node.keywords.length) return null;
      const inner = this.env(node.args[0]);
      if (inner !== null) return new Kind(inner.shape === "map" ? "keys" : inner.shape, true, false);
    }
    return null;
  }

  // ------------------------------------------------------------------ what is shown

  // Whether the expression is a `str` (a write needs one; a print does not).
  stringValued(node, ctx) {
    switch (node._) {
      case "JoinedStr":
        return true;
      case "BinOp":
        return node.op === "Add" || node.op === "Mod";
      case "Name":
        return ctx.values.has(node.id);
      case "Subscript":
        return this.valueOfKey(node, ctx) || this.pairValue(node, ctx);
      case "Call": {
        const made = this.qual(node.func);
        if (
          made === "builtins.str" || made === "builtins.repr" || made === "builtins.ascii" || made === "builtins.format" ||
          made === "json.dumps" || made === "pprint.pformat" || made === "urllib.parse.urlencode"
        ) {
          return true;
        }
        if (node.func._ === "Attribute" && (node.func.attr === "format" || node.func.attr === "join") && isText(node.func.value)) return true;
        if (node.func._ === "Attribute" && node.func.attr === "get" && node.args.length) return this.valueOfKey(node, ctx);
        return false;
      }
      default:
        return false;
    }
  }

  // `E[k]` or `E.get(k)` for a name `k` that is one of the environment's names.
  valueOfKey(node, ctx) {
    let base;
    let key;
    if (node._ === "Subscript") {
      base = node.value;
      key = node.slice;
    } else if (node._ === "Call" && node.func._ === "Attribute" && node.func.attr === "get" && node.args.length && !node.keywords.length) {
      base = node.func.value;
      key = node.args[0];
    } else return false;
    const inner = this.env(base);
    return inner !== null && inner.shape === "map" && isName(key) && ctx.keys.has(key.id);
  }

  // `pair[1]` for a name bound to a whole name/value pair.
  pairValue(node, ctx) {
    return node._ === "Subscript" && isName(node.value) && ctx.pairs.has(node.value.id) && isConst(node.slice) && equalsOne(node.slice.value);
  }

  // Whether the text of the expression carries an environment value.
  shows(node, ctx, asJson = false) {
    if (isConst(node)) return false;
    const kind = this.env(node);
    if (kind !== null) return asJson ? kind.inJson() : kind.inText();
    if (node._ === "Name") return ctx.values.has(node.id) || ctx.pairs.has(node.id);
    if (node._ === "Subscript" || (node._ === "Call" && this.valueOfKey(node, ctx))) {
      return this.valueOfKey(node, ctx) || this.pairValue(node, ctx);
    }
    switch (node._) {
      case "JoinedStr":
        return node.values.some((part) => part._ === "FormattedValue" && this.fieldShows(part, ctx));
      case "BinOp": {
        if (node.op === "Add") return this.shows(node.left, ctx) || this.shows(node.right, ctx);
        if (node.op === "Mod" && isText(node.left)) {
          const slots = percentSlots(node.left.value.v);
          const args = node.right._ === "Tuple" ? node.right.elts : [node.right];
          if (slots === null || slots.length !== args.length || args.some(isStarred)) return false;
          return slots.some((shown, i) => shown && this.shows(args[i], ctx));
        }
        return false;
      }
      case "Tuple":
      case "List":
      case "Set":
        return node.elts.some((elt) => this.elementShows(elt, ctx, asJson));
      case "Dict": {
        for (let i = 0; i < node.keys.length; i++) {
          if (node.keys[i] !== null && this.shows(node.keys[i], ctx, asJson)) return true;
          if (node.values[i] !== null && this.shows(node.values[i], ctx, asJson)) return true;
        }
        const own = this.env(node);
        return own !== null && own.inText();
      }
      case "ListComp":
      case "SetComp":
        return this.comprehensionShows(node, node.elt, ctx);
      case "DictComp":
        return this.comprehensionShows(node, { _: "Tuple", elts: [node.key, node.value], ctx: "Load" }, ctx);
      case "Call":
        return this.callShows(node, ctx);
      default:
        return false;
    }
  }

  elementShows(elt, ctx, asJson = false) {
    if (isStarred(elt)) {
      const kind = this.env(elt.value);
      return kind !== null ? kind.inIteration() : this.shows(elt.value, ctx, asJson);
    }
    return this.shows(elt, ctx, asJson);
  }

  fieldShows(field, ctx) {
    const spec = field.format_spec;
    if (spec !== null && spec !== undefined) {
      if (!spec.values.every(isConst)) return false;
      const text = spec.values.map((part) => part.value.v).join("");
      if (!WIDTH_ONLY.test(text)) return false;
      if (text && field.conversion === -1 && !this.isValue(field.value, ctx)) return false;
    }
    return this.shows(field.value, ctx);
  }

  // Whether the expression is one environment value (a `str`), which takes a format spec.
  isValue(node, ctx) {
    if (isName(node)) return ctx.values.has(node.id);
    return this.valueOfKey(node, ctx) || this.pairValue(node, ctx);
  }

  comprehensionShows(node, elt, ctx) {
    let inner = ctx;
    for (const generator of node.generators) {
      inner = this.bind(inner, generator.target, generator.iter);
      for (const cond of generator.ifs) {
        if (truth(cond) === false) return false; // nothing gets past a filter that is never true
        if (countLoads(cond, inner.names())) inner = NO_CTX;
      }
    }
    return this.shows(elt, inner);
  }

  callShows(call, ctx) {
    const made = this.qual(call.func);
    const args = call.args;
    const plain = !call.keywords.length && !args.some(isStarred);
    if ((made === "builtins.str" || made === "builtins.repr" || made === "builtins.ascii" || made === "pprint.pformat") && args.length === 1 && !args.some(isStarred)) {
      return this.shows(args[0], ctx);
    }
    if (made === "builtins.format" && args.length === 1 && plain) return this.shows(args[0], ctx);
    if (made === "json.dumps" && args.length && !isStarred(args[0])) {
      if (call.keywords.some((k) => k.arg === null || k.arg === "cls")) return false;
      return this.shows(args[0], ctx, true);
    }
    if (made === "urllib.parse.urlencode" && args.length && !isStarred(args[0])) {
      const kind = this.env(args[0]);
      return kind !== null && (kind.shape === "map" || kind.shape === "items");
    }
    const func = call.func;
    if (func._ === "Attribute" && func.attr === "encode" && !args.length) return this.shows(func.value, ctx);
    if (func._ === "Attribute" && isText(func.value)) {
      if (func.attr === "format") return this.formatShows(func.value.value.v, call, ctx);
      if (func.attr === "join" && args.length === 1 && !call.keywords.length) return this.joinShows(args[0], ctx);
    }
    return false;
  }

  formatShows(fmt, call, ctx) {
    const slots = braceSlots(fmt);
    if (slots === null || call.args.some(isStarred) || call.keywords.some((k) => k.arg === null)) return false;
    const keyword = new Map();
    for (const k of call.keywords) keyword.set(k.arg, k.value);
    for (const [key] of slots) {
      // a field with no argument raises before anything is shown
      if (typeof key === "number" ? key >= call.args.length : !keyword.has(key)) return false;
    }
    for (const [key, plain, needsText] of slots) {
      const argument = typeof key === "number" ? call.args[key] : keyword.get(key);
      if (plain && this.shows(argument, ctx) && (!needsText || this.isValue(argument, ctx))) return true;
    }
    return false;
  }

  joinShows(argument, ctx) {
    if (argument._ === "ListComp" || argument._ === "GeneratorExp") return this.comprehensionShows(argument, argument.elt, ctx);
    if (argument._ === "List" || argument._ === "Tuple") return argument.elts.some((elt) => this.elementShows(elt, ctx));
    const kind = this.env(argument);
    return kind !== null && kind.inIteration();
  }

  // ------------------------------------------------------------------ names that carry values

  // The context inside `for target in iterable`; names the target rebinds stop carrying values.
  bind(ctx, target, iterable) {
    let kind = this.env(iterable);
    if (kind !== null) {
      const added = kind.shape === "items" && (target._ === "Tuple" || target._ === "List") ? 2 : 1;
      if (ctx.keys.size + ctx.values.size + ctx.pairs.size + added > MAX_NAMES) kind = null; // names past the cap are not tracked
    }
    if (kind === null) {
      if (!ctx.live()) return ctx;
      const gone = new Set();
      for (const n of walk(target)) if (n._ === "Name") gone.add(n.id);
      return new Ctx(minus(ctx.keys, gone), minus(ctx.values, gone), minus(ctx.pairs, gone));
    }
    if (kind.shape === "items") {
      if (isName(target)) return new Ctx(ctx.keys, ctx.values, plus(ctx.pairs, target.id));
      if ((target._ === "Tuple" || target._ === "List") && target.elts.length === 2 && target.elts.every(isName)) {
        const [key, value] = target.elts;
        return new Ctx(plus(ctx.keys, key.id), plus(ctx.values, value.id), ctx.pairs);
      }
    } else if (kind.shape === "values" && isName(target)) {
      return new Ctx(ctx.keys, plus(ctx.values, target.id), ctx.pairs);
    } else if ((kind.shape === "map" || kind.shape === "keys") && isName(target)) {
      return new Ctx(plus(ctx.keys, target.id), ctx.values, ctx.pairs);
    }
    return ctx;
  }

  // ------------------------------------------------------------------ sinks

  // Whether the expression is a text stream the output is visible on or kept in.
  stream(node) {
    if (node === null || node === undefined || isNoneConst(node)) return true;
    const made = this.qual(node);
    if (made === "sys.stdout" || made === "sys.stderr") return true;
    if (isName(node)) return this.files.get(node.id) === 1 && this.stores.get(node.id) === 1;
    return this.openedForWriting(node);
  }

  // Whether a record at `level` is shown. With no literal level set in the file the default (warning and above)
  // applies; with one, the lowest literal level set; a level the reader cannot read hides debug and info. Never after
  // `logging.disable`.
  loggingShows(level) {
    if (this.loggingOff) return false;
    let low = null;
    for (const value of this.levels) if (value !== null && (low === null || value < low)) low = value;
    if (this.levels.includes(null) && level < 30) return false;
    return level >= (low !== null ? low : 30);
  }

  logMessageShows(call, ctx, skip) {
    const args = call.args.slice(skip);
    if (!args.length || call.args.some(isStarred)) return false;
    const [message, ...extra] = args;
    if (isText(message)) {
      const slots = percentSlots(message.value.v);
      if (!extra.length || slots === null || slots.length !== extra.length) return false;
      return slots.some((shown, i) => shown && this.shows(extra[i], ctx));
    }
    return !extra.length && this.shows(message, ctx);
  }

  // The name of the output call if `call` shows the environment, else null.
  sink(call, ctx) {
    const made = this.qual(call.func);
    const args = call.args;
    if (made === "builtins.print") {
      if (call.keywords.some((k) => k.arg === null)) return null;
      const found = call.keywords.find((k) => k.arg === "file");
      const file = found === undefined ? null : found.value;
      if (this.stream(file) && args.some((a) => this.elementShows(a, ctx))) return "print";
      return null;
    }
    if (made === "builtins.map" && args.length === 2 && this.qual(args[0]) === "builtins.print") {
      const kind = this.env(args[1]);
      return kind !== null && kind.inIteration() ? "print" : null;
    }
    if (made === "pprint.pprint" || made === "pprint.pp") {
      const found = call.keywords.find((k) => k.arg === "stream");
      const stream = found !== undefined ? found.value : args.length > 1 ? args[1] : null;
      if (args.length && !isStarred(args[0]) && this.stream(stream) && this.shows(args[0], ctx)) return "pprint";
      return null;
    }
    if (made === "json.dump" && args.length >= 2 && !args.some(isStarred)) {
      if (this.stream(args[1]) && this.shows(args[0], ctx, true)) return "json.dump";
      return null;
    }
    if (made && made.startsWith("logging.")) return this.logSink(call, ctx, made.split(".").pop(), 0);
    const func = call.func;
    if (func._ === "Attribute") {
      if (func.attr === "write" && args.length && !isStarred(args[0]) && this.stream(func.value)) {
        return this.stringValued(args[0], ctx) && this.shows(args[0], ctx) ? "write" : null;
      }
      if (func.attr === "write_text" && args.length && func.value._ === "Call" && this.qual(func.value.func) === "pathlib.Path" && !isStarred(args[0])) {
        const where = func.value.args.length ? func.value.args[0] : null;
        if ((isText(where) && where.value.v === "/dev/null") || this.qual(where) === "os.devnull") return null;
        return this.stringValued(args[0], ctx) && this.shows(args[0], ctx) ? "write_text" : null;
      }
      const receiver = func.value;
      const logger = this.boundOnce(receiver, this.loggers) || (receiver._ === "Call" && this.qual(receiver.func) === "logging.getLogger");
      if (logger) return this.logSink(call, ctx, func.attr, 0);
      if (this.boundOnce(receiver, this.sessions) && HTTP_VERBS.has(func.attr)) {
        return this.httpSink(call, ctx, func.attr, this.sessions.get(receiver.id));
      }
    }
    if (made) {
      const dot = made.lastIndexOf(".");
      const module = dot < 0 ? "" : made.slice(0, dot);
      const verb = made.slice(dot + 1);
      if (HTTP_MODULES.has(module) && HTTP_VERBS.has(verb)) return this.httpSink(call, ctx, verb, module);
    }
    return null;
  }

  // Whether the expression is a name that is bound exactly once, and that to one of `names`.
  boundOnce(node, names) {
    return isName(node) && names.has(node.id) && this.stores.get(node.id) === 1;
  }

  logSink(call, ctx, method, skip) {
    if (method === "log" && call.args.length) {
      const level = this.level(call.args[0]);
      if (!this.loggingShows(level === null ? 20 : level)) return null;
      return this.logMessageShows(call, ctx, 1) ? "logging" : null;
    }
    const level = LOG_HIGH.get(method) || LOG_LOW.get(method);
    if (level === undefined || !this.loggingShows(level)) return null;
    return this.logMessageShows(call, ctx, skip) ? "logging" : null;
  }

  httpSink(call, ctx, verb, module) {
    const keyword = new Map();
    for (const k of call.keywords) if (k.arg) keyword.set(k.arg, k.value);
    if (call.keywords.some((k) => k.arg === null) || call.args.some(isStarred)) return null;
    const sent = [];
    if (keyword.has("data")) sent.push(keyword.get("data"));
    // requests takes a body second for post/put/patch and params second for get; httpx takes neither
    else if (module === "requests" && (verb === "post" || verb === "put" || verb === "patch") && call.args.length > 1) sent.push(call.args[1]);
    if (keyword.has("params")) sent.push(keyword.get("params"));
    else if (module === "requests" && verb === "get" && call.args.length > 1) sent.push(call.args[1]);
    for (const body of sent) {
      const kind = this.env(body);
      if (kind !== null) {
        if (kind.shape === "map" || (kind.shape === "items" && kind.concrete)) return "http";
      } else if (this.shows(body, ctx)) return "http";
    }
    if (keyword.has("json") && ["data", "files"].every((name) => emptyBody(keyword.get(name))) && this.shows(keyword.get("json"), ctx, true)) {
      return "http";
    }
    return null;
  }

  // ------------------------------------------------------------------ the walk

  // The evidence of the first sink that shows the environment, or null.
  read() {
    try {
      this.block(this.tree.body, NO_CTX);
    } catch (error) {
      if (error instanceof Found) return error.evidence;
      throw error;
    }
    return null;
  }

  block(stmts, ctx) {
    for (const stmt of stmts) {
      this.stmt(stmt, ctx);
      if (stmt._ === "Return" || stmt._ === "Raise" || stmt._ === "Break" || stmt._ === "Continue") return;
    }
  }

  // Whether the statements assign, delete or import any of `names`.
  rebinds(body, names) {
    for (const stmt of body) {
      for (const node of walk(stmt)) {
        if (node._ === "Name" && (node.ctx === "Store" || node.ctx === "Del") && names.has(node.id)) return true;
        if (node._ === "Import" || node._ === "ImportFrom") {
          if (node.names.some((alias) => names.has(alias.asname || alias.name.split(".")[0]))) return true;
        }
      }
    }
    return false;
  }

  stmt(node, ctx) {
    switch (node._) {
      case "For":
      case "AsyncFor": {
        this.expr(node.iter, ctx);
        let inner = ctx;
        if (node._ === "For" && !(this.exits.get(node) || false)) {
          inner = this.bind(ctx, node.target, node.iter);
          const added = inner.names();
          const before = ctx.names();
          let fresh = false;
          for (const name of added) if (!before.has(name)) fresh = true;
          if (fresh && this.rebinds(node.body, added)) inner = NO_CTX;
        }
        this.block(node.body, inner);
        if (this.elseRuns(node)) this.block(node.orelse, ctx);
        break;
      }
      case "While":
        this.expr(node.test, ctx);
        if (truth(node.test) !== false) this.block(node.body, countLoads(node.test, ctx.names()) ? NO_CTX : ctx);
        if (this.elseRuns(node)) this.block(node.orelse, ctx);
        break;
      case "If": {
        this.expr(node.test, ctx);
        const t = truth(node.test);
        const inner = ctx.live() && countLoads(node.test, ctx.names()) ? NO_CTX : ctx;
        if (t !== false) this.block(node.body, inner);
        if (t !== true) this.block(node.orelse, inner);
        break;
      }
      case "FunctionDef":
      case "AsyncFunctionDef":
      case "ClassDef":
        for (const decorator of node.decorator_list) this.expr(decorator, ctx);
        this.block(node.body, NO_CTX);
        break;
      case "Match": {
        this.expr(node.subject, ctx);
        const inner = ctx.live() && countLoads(node.subject, ctx.names()) ? NO_CTX : ctx;
        for (const kase of node.cases) {
          let body = inner;
          if (kase.guard !== null) {
            this.expr(kase.guard, inner);
            if (inner.live() && countLoads(kase.guard, inner.names())) body = NO_CTX; // the guard picks which names get this case
            if (truth(kase.guard) === false) continue; // a case that never matches
          }
          this.block(kase.body, body);
        }
        break;
      }
      case "With":
      case "AsyncWith":
        for (const item of node.items) this.expr(item.context_expr, ctx);
        this.block(node.body, ctx);
        break;
      case "Try":
      case "TryStar":
        this.block(node.body, ctx);
        for (const handler of node.handlers) this.block(handler.body, ctx);
        this.block(node.orelse, ctx);
        this.block(node.finalbody, ctx);
        break;
      default:
        for (const child of children(node)) if (isExpr(child)) this.expr(child, ctx);
    }
  }

  expr(node, ctx) {
    if (node._ === "Call") {
      const shown = this.sink(node, ctx);
      if (shown !== null) throw new Found({ sink: shown, line: node.lineno, shape: ctx.live() ? "loop" : "whole_environment" });
    }
    switch (node._) {
      case "IfExp": {
        this.expr(node.test, ctx);
        const t = truth(node.test);
        const inner = ctx.live() && countLoads(node.test, ctx.names()) ? NO_CTX : ctx;
        if (t !== false) this.expr(node.body, inner);
        if (t !== true) this.expr(node.orelse, inner);
        return;
      }
      case "BoolOp": {
        let inner = ctx;
        const isOr = node.op === "Or";
        for (const value of node.values) {
          this.expr(value, inner);
          if (truth(value) === isOr) break; // the rest is never evaluated
          if (inner.live() && countLoads(value, inner.names())) inner = NO_CTX;
        }
        return;
      }
      case "ListComp":
      case "SetComp":
      case "GeneratorExp":
      case "DictComp": {
        let inner = ctx;
        this.expr(node.generators[0].iter, inner); // the first iterable is evaluated at once, always
        for (let index = 0; index < node.generators.length; index++) {
          const generator = node.generators[index];
          if (index) this.expr(generator.iter, inner);
          inner = this.bind(inner, generator.target, generator.iter);
          for (const cond of generator.ifs) {
            this.expr(cond, inner);
            if (truth(cond) === false) return; // nothing gets past a filter that is never true
            if (inner.live() && countLoads(cond, inner.names())) inner = NO_CTX;
          }
        }
        for (const part of node._ === "DictComp" ? [node.key, node.value] : [node.elt]) this.expr(part, inner);
        return;
      }
      case "Lambda":
        this.expr(node.body, NO_CTX);
        return;
      default:
        for (const child of children(node)) this.expr(child, ctx);
    }
  }
}

// ---------------------------------------------------------------------------------------------- the trees

// textwrap.dedent: the common leading white space (spaces and tabs) of the lines with something on them is removed,
// and a line of white space only becomes empty.
function dedent(text) {
  const lines = text.split("\n");
  let margin = null;
  for (const line of lines) {
    if (line === "" || SPACE_ONLY.test(line)) continue;
    let k = 0;
    while (k < line.length && (line[k] === " " || line[k] === "\t")) k += 1;
    const lead = line.slice(0, k);
    if (margin === null) margin = lead;
    else {
      let j = 0;
      while (j < margin.length && j < lead.length && margin[j] === lead[j]) j += 1;
      margin = margin.slice(0, j);
    }
  }
  const cut = margin === null ? 0 : margin.length;
  return lines.map((line) => (line !== "" && SPACE_ONLY.test(line) ? "" : line.slice(cut))).join("\n");
}

// The text as one module; if it is not Python, each fenced python block on its own.
function pythonTrees(text) {
  const tree = parsePython(text);
  if (tree !== null) return [[text, tree]];
  const trees = [];
  for (const block of fencedBlocks(text, PYTHON_TAG)) {
    const source = dedent(block);
    const found = parsePython(source);
    if (found !== null) trees.push([source, found]);
  }
  return trees;
}

export const EnvironmentDumpedByPython = {
  id: "GLS-STRUCT-005",
  name: "Python program prints or sends the whole environment",
  category: "exfiltration",
  severity: "medium",
  channel: ["file", "code"],
  description:
    "Python code that reads as one that prints, logs, writes or sends every environment " +
    "variable, with its value, where an agent or whoever reads the output will see the " +
    "secrets (API keys, tokens). It is a judgment from the syntax tree, not proof that the " +
    "code runs: a debug helper that dumps the environment is the dump it is, so this is a " +
    "finding to look at, not a block.",

  pregate(text) {
    return ENV_WORD.test(text);
  },

  run(text) {
    for (const [source, tree] of pythonTrees(text)) {
      const evidence = new EnvironmentReader(tree).read();
      if (evidence === null) continue;
      const lines = pySplitlines(source);
      const line = evidence.line <= lines.length ? pyStrip(lines[evidence.line - 1]) : "";
      return [
        {
          id: this.id,
          name: this.name,
          category: this.category,
          severity: this.severity,
          channel: [...this.channel],
          description: this.description,
          matched_text: cpHead(line, 50),
          structural: true,
          evidence,
        },
      ];
    }
    return [];
  },
};

export { PySyntax };
