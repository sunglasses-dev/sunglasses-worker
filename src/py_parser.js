// A parser for Python source (3.14 grammar) that makes the tree the interpreter's `ast.parse` makes, as far as the
// reader of Python code needs it: every node type, its fields in the interpreter's order, the line of each statement,
// expression and argument, and the contexts (Load, Store, Del) of names, attributes, subscripts and sequences.
// A text that is not a program raises PySyntax.
import { lowerPinned } from "./pinned.js";
import { KEYWORDS, Lexer, PySyntax, Source, decode, fail, identifier, setFStringHook } from "./py_lexer.js";

export { PySyntax };

// The fields of each node type, in the order of the interpreter's `_fields`.
export const SCHEMA = {
  Module: ["body"],
  FunctionDef: ["name", "args", "body", "decorator_list", "returns", "type_comment", "type_params"],
  AsyncFunctionDef: ["name", "args", "body", "decorator_list", "returns", "type_comment", "type_params"],
  ClassDef: ["name", "bases", "keywords", "body", "decorator_list", "type_params"],
  Return: ["value"],
  Delete: ["targets"],
  Assign: ["targets", "value", "type_comment"],
  TypeAlias: ["name", "type_params", "value"],
  AugAssign: ["target", "op", "value"],
  AnnAssign: ["target", "annotation", "value", "simple"],
  For: ["target", "iter", "body", "orelse", "type_comment"],
  AsyncFor: ["target", "iter", "body", "orelse", "type_comment"],
  While: ["test", "body", "orelse"],
  If: ["test", "body", "orelse"],
  With: ["items", "body", "type_comment"],
  AsyncWith: ["items", "body", "type_comment"],
  Match: ["subject", "cases"],
  Raise: ["exc", "cause"],
  Try: ["body", "handlers", "orelse", "finalbody"],
  TryStar: ["body", "handlers", "orelse", "finalbody"],
  Assert: ["test", "msg"],
  Import: ["names"],
  ImportFrom: ["module", "names", "level"],
  Global: ["names"],
  Nonlocal: ["names"],
  Expr: ["value"],
  Pass: [],
  Break: [],
  Continue: [],
  BoolOp: ["op", "values"],
  NamedExpr: ["target", "value"],
  BinOp: ["left", "op", "right"],
  UnaryOp: ["op", "operand"],
  Lambda: ["args", "body"],
  IfExp: ["test", "body", "orelse"],
  Dict: ["keys", "values"],
  Set: ["elts"],
  ListComp: ["elt", "generators"],
  SetComp: ["elt", "generators"],
  DictComp: ["key", "value", "generators"],
  GeneratorExp: ["elt", "generators"],
  Await: ["value"],
  Yield: ["value"],
  YieldFrom: ["value"],
  Compare: ["left", "ops", "comparators"],
  Call: ["func", "args", "keywords"],
  FormattedValue: ["value", "conversion", "format_spec"],
  Interpolation: ["value", "str", "conversion", "format_spec"],
  JoinedStr: ["values"],
  TemplateStr: ["values"],
  Constant: ["value", "kind"],
  Attribute: ["value", "attr", "ctx"],
  Subscript: ["value", "slice", "ctx"],
  Starred: ["value", "ctx"],
  Name: ["id", "ctx"],
  List: ["elts", "ctx"],
  Tuple: ["elts", "ctx"],
  Slice: ["lower", "upper", "step"],
  comprehension: ["target", "iter", "ifs", "is_async"],
  ExceptHandler: ["type", "name", "body"],
  arguments: ["posonlyargs", "args", "vararg", "kwonlyargs", "kw_defaults", "kwarg", "defaults"],
  arg: ["arg", "annotation", "type_comment"],
  keyword: ["arg", "value"],
  alias: ["name", "asname"],
  withitem: ["context_expr", "optional_vars"],
  match_case: ["pattern", "guard", "body"],
  MatchValue: ["value"],
  MatchSingleton: ["value"],
  MatchSequence: ["patterns"],
  MatchMapping: ["keys", "patterns", "rest"],
  MatchClass: ["cls", "patterns", "kwd_attrs", "kwd_patterns"],
  MatchStar: ["name"],
  MatchAs: ["pattern", "name"],
  MatchOr: ["patterns"],
  TypeVar: ["name", "bound", "default_value"],
  ParamSpec: ["name", "default_value"],
  TypeVarTuple: ["name", "default_value"],
};

const isNode = (x) => x !== null && typeof x === "object" && typeof x._ === "string";

// The child nodes of a node, in field order (the interpreter's iter_child_nodes).
export function children(node) {
  const out = [];
  for (const field of SCHEMA[node._]) {
    const value = node[field];
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) out.push(item);
    } else if (isNode(value)) out.push(value);
  }
  return out;
}

// Every node below and including `root`, breadth first (the interpreter's ast.walk).
export function walk(root) {
  const todo = [root];
  for (let i = 0; i < todo.length; i++) for (const child of children(todo[i])) todo.push(child);
  return todo;
}

const N = (type, line, fields) => ({ _: type, lineno: line, ...fields });

const BIN = {
  "|": ["BitOr", 1], "^": ["BitXor", 2], "&": ["BitAnd", 3], "<<": ["LShift", 4], ">>": ["RShift", 4], "+": ["Add", 5],
  "-": ["Sub", 5], "*": ["Mult", 6], "/": ["Div", 6], "//": ["FloorDiv", 6], "%": ["Mod", 6], "@": ["MatMult", 6],
};
const AUG = {
  "+=": "Add", "-=": "Sub", "*=": "Mult", "/=": "Div", "//=": "FloorDiv", "%=": "Mod", "@=": "MatMult", "&=": "BitAnd",
  "|=": "BitOr", "^=": "BitXor", ">>=": "RShift", "<<=": "LShift", "**=": "Pow",
};
const COMPARE = { "==": "Eq", "!=": "NotEq", "<": "Lt", "<=": "LtE", ">": "Gt", ">=": "GtE" };
const EXPR_KEYWORDS = new Set(["not", "lambda", "await", "None", "True", "False"]);
// The interpreter's parser gives up (a memory error) when its rules nest 5969 deep; each kind of nesting uses a
// number of rule levels, measured here. A chain of operators, attributes, calls or subscripts is limited by the
// depth of the tree the interpreter builds (95088).
const MAX_DEPTH = 5969;
const MAX_HEIGHT = 95088;
const COST_BRACKET = 28;
const COST_CALL = 24;
const COST_SUBSCRIPT = 26;
const height = (n) => n.h || 1;
const raised = (node, ...parts) => {
  node.h = 1 + Math.max(...parts.map(height));
  if (node.h > MAX_HEIGHT) fail("too deeply nested");
  return node;
};

function constant(value, kind = null) {
  return { _: "Constant", lineno: 0, value, kind };
}

class Parser {
  constructor(lexer) {
    this.lex = lexer;
    this.toks = [];
    this.i = 0;
    this.depth = 0;
    this.barry = false;
  }

  peek(k = 0) {
    while (this.toks.length <= this.i + k) this.toks.push(this.lex.next());
    return this.toks[this.i + k];
  }
  take() {
    const t = this.peek();
    this.i += 1;
    return t;
  }
  isOp(v, k = 0) {
    const t = this.peek(k);
    return t.t === "OP" && t.v === v;
  }
  isKw(v, k = 0) {
    const t = this.peek(k);
    return t.t === "NAME" && t.v === v;
  }
  eatOp(v) {
    if (this.isOp(v)) {
      this.i += 1;
      return true;
    }
    return false;
  }
  eatKw(v) {
    if (this.isKw(v)) {
      this.i += 1;
      return true;
    }
    return false;
  }
  expectOp(v) {
    if (!this.eatOp(v)) fail(`expected '${v}'`);
  }
  expectKw(v) {
    if (!this.eatKw(v)) fail(`expected '${v}'`);
  }
  isName(k = 0) {
    const t = this.peek(k);
    return t.t === "NAME" && !KEYWORDS.has(t.v);
  }
  expectName() {
    const t = this.peek();
    if (t.t !== "NAME" || KEYWORDS.has(t.v)) fail("invalid syntax");
    this.i += 1;
    return t;
  }
  enter(cost = 1) {
    this.depth += cost;
    if (this.depth > MAX_DEPTH) fail("too deeply nested");
  }
  leave(cost = 1) {
    this.depth -= cost;
  }

  // ------------------------------------------------------------------------------------------ expressions

  startsExpr(t = this.peek()) {
    if (t.t === "NUM" || t.t === "STR") return true;
    if (t.t === "NAME") return !KEYWORDS.has(t.v) || EXPR_KEYWORDS.has(t.v);
    if (t.t === "OP") return "([{-+~...".includes(t.v) && t.v.length === 1 ? true : t.v === "...";
    return false;
  }

  // star_expressions: one or more expressions, a comma making a tuple.
  starExpressions() {
    const first = this.peek();
    const e = this.starExpression();
    if (!this.isOp(",")) return e;
    const elts = [e];
    while (this.eatOp(",")) {
      if (!(this.startsExpr() || this.isOp("*"))) break;
      elts.push(this.starExpression());
    }
    return N("Tuple", first.line, { elts, ctx: "Load" });
  }

  starExpression() {
    if (this.isOp("*")) {
      const t = this.take();
      return N("Starred", t.line, { value: this.bitOr(), ctx: "Load" });
    }
    return this.expression();
  }

  starNamedExpression() {
    if (this.isOp("*")) {
      const t = this.take();
      return N("Starred", t.line, { value: this.bitOr(), ctx: "Load" });
    }
    return this.namedExpression();
  }

  namedExpression() {
    const t = this.peek();
    if (t.t === "NAME" && !KEYWORDS.has(t.v) && this.isOp(":=", 1)) {
      this.i += 2;
      const value = this.expression();
      return N("NamedExpr", t.line, { target: N("Name", t.line, { id: t.v, ctx: "Store" }), value });
    }
    const e = this.expression();
    if (this.isOp(":=")) fail("invalid syntax");
    return e;
  }

  expression() {
    if (this.isKw("lambda")) return this.lambda();
    const first = this.peek();
    const body = this.disjunction();
    if (this.isKw("if")) {
      this.i += 1;
      const test = this.disjunction();
      this.expectKw("else");
      this.enter();
      try {
        const orelse = this.expression();
        return N("IfExp", first.line, { test, body, orelse });
      } finally {
        this.leave();
      }
    }
    return body;
  }

  disjunction() {
    const first = this.peek();
    const left = this.conjunction();
    if (!this.isKw("or")) return left;
    const values = [left];
    while (this.eatKw("or")) values.push(this.conjunction());
    return N("BoolOp", first.line, { op: "Or", values });
  }

  conjunction() {
    const first = this.peek();
    const left = this.inversion();
    if (!this.isKw("and")) return left;
    const values = [left];
    while (this.eatKw("and")) values.push(this.inversion());
    return N("BoolOp", first.line, { op: "And", values });
  }

  inversion() {
    if (this.isKw("not")) {
      const t = this.take();
      this.enter();
      try {
        return N("UnaryOp", t.line, { op: "Not", operand: this.inversion() });
      } finally {
        this.leave();
      }
    }
    return this.comparison();
  }

  comparison() {
    const first = this.peek();
    const left = this.bitOr();
    const ops = [];
    const comparators = [];
    for (;;) {
      const t = this.peek();
      let op = null;
      if (t.t === "OP" && t.v === "<>") {
        if (!this.barry) fail("invalid syntax");
        op = "NotEq";
        this.i += 1;
      } else if (t.t === "OP" && COMPARE[t.v]) {
        if (t.v === "!=" && this.barry) fail("invalid syntax");
        op = COMPARE[t.v];
        this.i += 1;
      } else if (t.t === "NAME" && t.v === "in") {
        op = "In";
        this.i += 1;
      } else if (t.t === "NAME" && t.v === "not" && this.isKw("in", 1)) {
        op = "NotIn";
        this.i += 2;
      } else if (t.t === "NAME" && t.v === "is") {
        this.i += 1;
        op = this.eatKw("not") ? "IsNot" : "Is";
      } else break;
      ops.push(op);
      comparators.push(this.bitOr());
    }
    return ops.length ? N("Compare", first.line, { left, ops, comparators }) : left;
  }

  bitOr() {
    return this.climb(1);
  }

  climb(min) {
    const first = this.peek();
    let left = this.factor();
    for (;;) {
      const t = this.peek();
      if (t.t !== "OP") break;
      const info = BIN[t.v];
      if (!info || info[1] < min) break;
      this.i += 1;
      const right = this.climb(info[1] + 1);
      left = raised(N("BinOp", first.line, { left, op: info[0], right }), left, right);
    }
    return left;
  }

  factor() {
    const t = this.peek();
    if (t.t === "OP" && (t.v === "+" || t.v === "-" || t.v === "~")) {
      this.i += 1;
      this.enter();
      try {
        return N("UnaryOp", t.line, { op: t.v === "+" ? "UAdd" : t.v === "-" ? "USub" : "Invert", operand: this.factor() });
      } finally {
        this.leave();
      }
    }
    return this.power();
  }

  power() {
    const first = this.peek();
    const left = this.awaitPrimary();
    if (this.eatOp("**")) {
      this.enter(2);
      try {
        const right = this.factor();
        return raised(N("BinOp", first.line, { left, op: "Pow", right }), left, right);
      } finally {
        this.leave(2);
      }
    }
    return left;
  }

  awaitPrimary() {
    if (this.isKw("await")) {
      const t = this.take();
      return N("Await", t.line, { value: this.primary() });
    }
    return this.primary();
  }

  primary() {
    const first = this.peek();
    let e = this.atom();
    for (;;) {
      if (this.isOp(".")) {
        this.i += 1;
        const name = this.expectName();
        e = raised(N("Attribute", first.line, { value: e, attr: name.v, ctx: "Load" }), e);
      } else if (this.isOp("(")) {
        this.i += 1;
        this.enter(COST_CALL);
        try {
          e = raised(this.callTail(e, first), e);
        } finally {
          this.leave(COST_CALL);
        }
      } else if (this.isOp("[")) {
        this.i += 1;
        this.enter(COST_SUBSCRIPT);
        try {
          const slice = this.slices();
          this.expectOp("]");
          e = raised(N("Subscript", first.line, { value: e, slice, ctx: "Load" }), e, slice);
        } finally {
          this.leave(COST_SUBSCRIPT);
        }
      } else break;
    }
    return e;
  }

  // The arguments of a call after its '(' : [args, keywords, whether a lone generator expression was the argument].
  callArguments(open) {
    const args = [];
    const keywords = [];
    let sawKeyword = false;
    let sawDouble = false;
    let genexp = false;
    let count = 0;
    while (!this.isOp(")")) {
      const t = this.peek();
      count += 1;
      if (this.isOp("*")) {
        this.i += 1;
        if (sawDouble) fail("iterable argument unpacking follows keyword argument unpacking");
        args.push(N("Starred", t.line, { value: this.expression(), ctx: "Load" }));
      } else if (this.isOp("**")) {
        this.i += 1;
        sawDouble = true;
        keywords.push(N("keyword", t.line, { arg: null, value: this.expression() }));
      } else if (t.t === "NAME" && !KEYWORDS.has(t.v) && this.isOp("=", 1)) {
        this.i += 2;
        sawKeyword = true;
        keywords.push(N("keyword", t.line, { arg: t.v, value: this.expression() }));
      } else {
        let e = this.namedExpression();
        if (this.isKw("for") || this.isKw("async")) {
          if (count > 1 || args.length || keywords.length) fail("Generator expression must be parenthesized");
          const generators = this.forIfClauses();
          e = N("GeneratorExp", open.line, { elt: e, generators });
          genexp = true;
          if (!this.isOp(")")) fail("Generator expression must be parenthesized");
        } else if (this.isOp("=")) {
          fail("expression cannot contain assignment");
        }
        if (sawKeyword || sawDouble) fail("positional argument follows keyword argument");
        args.push(e);
      }
      if (!this.eatOp(",")) break;
    }
    this.expectOp(")");
    return [args, keywords, genexp];
  }

  callTail(func, first) {
    const open = this.toks[this.i - 1];
    const [args, keywords] = this.callArguments(open);
    return N("Call", first.line, { func, args, keywords });
  }

  slices() {
    const first = this.peek();
    const one = this.sliceItem();
    if (!this.isOp(",")) {
      if (one._ === "Starred") return N("Tuple", first.line, { elts: [one], ctx: "Load" });
      return one;
    }
    const elts = [one];
    while (this.eatOp(",")) {
      if (this.isOp("]")) break;
      elts.push(this.sliceItem());
    }
    return N("Tuple", first.line, { elts, ctx: "Load" });
  }

  sliceItem() {
    const first = this.peek();
    if (this.isOp("*")) {
      this.i += 1;
      return N("Starred", first.line, { value: this.bitOr(), ctx: "Load" });
    }
    let lower = null;
    if (!this.isOp(":")) {
      lower = this.namedExpression();
      if (!this.isOp(":")) return lower;
      if (lower._ === "NamedExpr" && !lower.paren) fail("invalid syntax");
    }
    this.expectOp(":");
    let upper = null;
    let step = null;
    if (!this.isOp(":") && !this.isOp(",") && !this.isOp("]")) upper = this.expression();
    if (this.eatOp(":")) {
      if (!this.isOp(",") && !this.isOp("]")) step = this.expression();
    }
    return N("Slice", first.line, { lower, upper, step });
  }

  lambda() {
    const t = this.take();
    if (this.lex.mode === "field" && this.lex.stack.length === 0) fail("f-string: lambda expressions are not allowed without parentheses");
    const args = this.parameters(true);
    this.expectOp(":");
    this.enter(2);
    try {
      const body = this.expression();
      return N("Lambda", t.line, { args, body });
    } finally {
      this.leave(2);
    }
  }

  forIfClauses() {
    const out = [];
    while (this.isKw("for") || (this.isKw("async") && this.isKw("for", 1))) {
      const isAsync = this.eatKw("async") ? 1 : 0;
      this.expectKw("for");
      const target = this.targets("Store");
      this.expectKw("in");
      const iter = this.disjunction();
      const ifs = [];
      while (this.eatKw("if")) ifs.push(this.disjunction());
      out.push({ _: "comprehension", target, iter, ifs, is_async: isAsync });
    }
    if (!out.length) fail("invalid syntax");
    return out;
  }

  // The targets of a `for`: star targets separated by commas, up to the `in`.
  targets(ctx) {
    const first = this.peek();
    const one = this.targetElement();
    let result = one;
    if (this.isOp(",")) {
      const elts = [one];
      while (this.eatOp(",")) {
        if (this.isKw("in") || this.isOp("=") || this.isOp(":") || this.isOp(")")) break;
        elts.push(this.targetElement());
      }
      result = N("Tuple", first.line, { elts, ctx });
    }
    return this.assignTo(result, ctx);
  }

  targetElement() {
    if (this.isOp("*")) {
      const t = this.take();
      return N("Starred", t.line, { value: this.bitOr(), ctx: "Load" });
    }
    return this.bitOr();
  }

  // The expression `node` as the target of an assignment, a `for`, a `with` or a `del`: contexts set, shapes checked.
  assignTo(node, ctx) {
    switch (node._) {
      case "Name":
      case "Attribute":
      case "Subscript":
        node.ctx = ctx;
        return node;
      case "Starred":
        if (ctx === "Del") fail("cannot delete starred");
        node.ctx = ctx;
        this.assignTo(node.value, ctx);
        return node;
      case "Tuple":
      case "List":
        node.ctx = ctx;
        for (const e of node.elts) this.assignTo(e, ctx);
        return node;
      default:
        fail("cannot assign to expression");
    }
    return node;
  }

  yieldExpr() {
    const t = this.take();
    if (this.eatKw("from")) return N("YieldFrom", t.line, { value: this.expression() });
    const value = this.startsExpr() || this.isOp("*") ? this.starExpressions() : null;
    return N("Yield", t.line, { value });
  }

  atom() {
    const t = this.peek();
    switch (t.t) {
      case "NAME": {
        if (t.v === "True" || t.v === "False" || t.v === "None") {
          this.i += 1;
          return N("Constant", t.line, { value: { k: t.v === "None" ? "None" : "bool", v: t.v === "True" }, kind: null });
        }
        if (KEYWORDS.has(t.v)) fail("invalid syntax");
        this.i += 1;
        return N("Name", t.line, { id: t.v, ctx: "Load" });
      }
      case "NUM":
        this.i += 1;
        return N("Constant", t.line, { value: numberValue(t), kind: null });
      case "STR":
        return this.strings();
      case "OP":
        if (t.v === "(") return this.parenthesized();
        if (t.v === "[") return this.listDisplay();
        if (t.v === "{") return this.braceDisplay();
        if (t.v === "...") {
          this.i += 1;
          return N("Constant", t.line, { value: { k: "Ellipsis" }, kind: null });
        }
        break;
      default:
    }
    fail("invalid syntax");
    return null;
  }

  parenthesized() {
    const open = this.take();
    this.enter(COST_BRACKET);
    try {
      if (this.eatOp(")")) return N("Tuple", open.line, { elts: [], ctx: "Load" });
      if (this.isKw("yield")) {
        const e = this.yieldExpr();
        this.expectOp(")");
        e.paren = true;
        return e;
      }
      const e = this.starNamedExpression();
      if ((this.isKw("for") || this.isKw("async")) && e._ !== "Starred") {
        const generators = this.forIfClauses();
        this.expectOp(")");
        return N("GeneratorExp", open.line, { elt: e, generators });
      }
      if (this.isOp(",")) {
        const elts = [e];
        while (this.eatOp(",")) {
          if (this.isOp(")")) break;
          elts.push(this.starNamedExpression());
        }
        this.expectOp(")");
        const tuple = N("Tuple", open.line, { elts, ctx: "Load" });
        tuple.paren = true;
        return tuple;
      }
      this.expectOp(")");
      if (e._ === "Starred") fail("cannot use starred expression here");
      e.paren = true;
      return e;
    } finally {
      this.leave(COST_BRACKET);
    }
  }

  listDisplay() {
    const open = this.take();
    this.enter(COST_BRACKET);
    try {
      if (this.eatOp("]")) return N("List", open.line, { elts: [], ctx: "Load" });
      const e = this.starNamedExpression();
      if ((this.isKw("for") || this.isKw("async")) && e._ !== "Starred") {
        const generators = this.forIfClauses();
        this.expectOp("]");
        return N("ListComp", open.line, { elt: e, generators });
      }
      const elts = [e];
      while (this.eatOp(",")) {
        if (this.isOp("]")) break;
        elts.push(this.starNamedExpression());
      }
      this.expectOp("]");
      return N("List", open.line, { elts, ctx: "Load" });
    } finally {
      this.leave(COST_BRACKET);
    }
  }

  braceDisplay() {
    const open = this.take();
    this.enter(COST_BRACKET);
    try {
      if (this.eatOp("}")) return N("Dict", open.line, { keys: [], values: [] });
      const keys = [];
      const values = [];
      if (this.isOp("**")) {
        this.i += 1;
        keys.push(null);
        values.push(this.bitOr());
      } else {
        const e = this.starNamedExpression();
        if (this.isOp(":") && e._ !== "Starred") {
          if (e._ === "NamedExpr" && !e.paren) fail("invalid syntax");
          this.i += 1;
          const value = this.expression();
          if (this.isKw("for") || this.isKw("async")) {
            const generators = this.forIfClauses();
            this.expectOp("}");
            return N("DictComp", open.line, { key: e, value, generators });
          }
          keys.push(e);
          values.push(value);
        } else {
          // a set
          if ((this.isKw("for") || this.isKw("async")) && e._ !== "Starred") {
            const generators = this.forIfClauses();
            this.expectOp("}");
            return N("SetComp", open.line, { elt: e, generators });
          }
          const elts = [e];
          while (this.eatOp(",")) {
            if (this.isOp("}")) break;
            elts.push(this.starNamedExpression());
          }
          this.expectOp("}");
          return N("Set", open.line, { elts });
        }
      }
      while (this.eatOp(",")) {
        if (this.isOp("}")) break;
        if (this.eatOp("**")) {
          keys.push(null);
          values.push(this.bitOr());
        } else {
          keys.push(this.expression());
          this.expectOp(":");
          values.push(this.expression());
        }
      }
      this.expectOp("}");
      return N("Dict", open.line, { keys, values });
    } finally {
      this.leave(COST_BRACKET);
    }
  }

  // Adjacent string literals: one constant, or one f-string / t-string.
  strings() {
    const first = this.peek();
    const toks = [];
    while (this.peek().t === "STR") toks.push(this.take());
    const anyBytes = toks.some((t) => t.bytes);
    if (anyBytes && toks.some((t) => !t.bytes)) fail("cannot mix bytes and nonbytes literals");
    const templates = toks.some((t) => t.template);
    if (templates && toks.some((t) => !t.template)) fail("cannot mix t-string literals with string or bytes literals");
    const kind = toks[0].prefix.includes("u") ? "u" : null;
    if (anyBytes) {
      return N("Constant", first.line, { value: { k: "bytes", v: toks.map((t) => t.value.bytes).join("") }, kind: null });
    }
    if (!toks.some((t) => t.parts)) {
      return N("Constant", first.line, { value: { k: "str", v: toks.map((t) => t.value).join("") }, kind });
    }
    const values = [];
    let pending = "";
    const flush = () => {
      if (pending) values.push(N("Constant", first.line, { value: { k: "str", v: pending }, kind: null }));
      pending = "";
    };
    for (const t of toks) {
      if (!t.parts) {
        pending += t.value;
        continue;
      }
      for (const part of t.parts) {
        if (part.lit !== undefined) pending += part.lit;
        else {
          flush();
          values.push(part.node);
        }
      }
    }
    flush();
    return N(templates ? "TemplateStr" : "JoinedStr", first.line, { values });
  }

  // ------------------------------------------------------------------------------------------ parameters

  // The parameters of a def (up to its ')') or of a lambda (up to its ':'): an `arguments` node.
  parameters(isLambda) {
    const end = isLambda ? ":" : ")";
    const posonly = [];
    let args = [];
    let vararg = null;
    const kwonly = [];
    const kwDefaults = [];
    let kwarg = null;
    const defaults = [];
    let sawSlash = false;
    let sawStar = false;
    let sawDefault = false;
    const param = (star) => {
      const t = this.expectName();
      let annotation = null;
      if (!isLambda && this.eatOp(":")) {
        if (star && this.isOp("*")) {
          const s = this.take();
          annotation = N("Starred", s.line, { value: this.bitOr(), ctx: "Load" });
        } else annotation = this.expression();
      }
      return N("arg", t.line, { arg: t.v, annotation, type_comment: null });
    };
    while (!this.isOp(end)) {
      if (kwarg) fail("arguments cannot follow var-keyword argument");
      if (this.isOp("/")) {
        if (sawSlash || sawStar || !args.length) fail("invalid '/'");
        this.i += 1;
        sawSlash = true;
        posonly.push(...args);
        args = [];
      } else if (this.isOp("*")) {
        if (sawStar) fail("* argument may appear only once");
        this.i += 1;
        sawStar = true;
        if (this.isOp(",")) {
          if (this.isOp(end, 1) || this.isOp("**", 1)) fail("named arguments must follow bare *");
        } else if (this.isOp(end)) fail("named arguments must follow bare *");
        else {
          vararg = param(true);
          if (this.isOp("=")) fail("var-positional argument cannot have default value");
        }
      } else if (this.isOp("**")) {
        this.i += 1;
        kwarg = param(false);
        if (this.isOp("=")) fail("var-keyword argument cannot have default value");
      } else {
        const p = param(false);
        let value = null;
        if (this.eatOp("=")) value = this.expression();
        if (sawStar) {
          kwonly.push(p);
          kwDefaults.push(value);
        } else {
          args.push(p);
          if (value !== null) {
            defaults.push(value);
            sawDefault = true;
          } else if (sawDefault) fail("non-default argument follows default argument");
        }
      }
      if (!this.eatOp(",")) break;
    }
    return { _: "arguments", posonlyargs: posonly, args, vararg, kwonlyargs: kwonly, kw_defaults: kwDefaults, kwarg, defaults };
  }

  // ------------------------------------------------------------------------------------------ statements

  file() {
    const body = [];
    for (;;) {
      const t = this.peek();
      if (t.t === "END") break;
      this.statement(body);
    }
    return { _: "Module", body };
  }

  // One statement line into `out` (a simple-statement line can hold several statements).
  statement(out) {
    const t = this.peek();
    if (t.t === "INDENT") fail("unexpected indent");
    if (t.t === "DEDENT" || t.t === "NEWLINE") fail("invalid syntax");
    if (t.t === "NAME") {
      switch (t.v) {
        case "if": return void out.push(this.ifStatement());
        case "while": return void out.push(this.whileStatement());
        case "for": return void out.push(this.forStatement(false, t));
        case "try": return void out.push(this.tryStatement());
        case "with": return void out.push(this.withStatement(false, t));
        case "def": return void out.push(this.funcDef(false, t, []));
        case "class": return void out.push(this.classDef(t, []));
        case "async": {
          this.i += 1;
          if (this.isKw("def")) return void out.push(this.funcDef(true, t, []));
          if (this.isKw("for")) return void out.push(this.forStatement(true, t));
          if (this.isKw("with")) return void out.push(this.withStatement(true, t));
          fail("invalid syntax");
          break;
        }
        case "match": {
          const mark = this.i;
          try {
            return void out.push(this.matchStatement());
          } catch (error) {
            if (!(error instanceof PySyntax)) throw error;
            this.i = mark;
          }
          break;
        }
        default:
      }
    }
    if (t.t === "OP" && t.v === "@") return void out.push(this.decorated());
    this.simpleStatements(out);
  }

  simpleStatements(out) {
    for (;;) {
      out.push(this.simpleStatement());
      if (this.eatOp(";")) {
        if (this.peek().t === "NEWLINE") break;
        continue;
      }
      break;
    }
    if (this.peek().t !== "NEWLINE" && this.peek().t !== "END") fail("invalid syntax");
    if (this.peek().t === "NEWLINE") this.i += 1;
  }

  block() {
    this.expectOp(":");
    const body = [];
    if (this.peek().t === "NEWLINE") {
      this.i += 1;
      if (this.peek().t !== "INDENT") fail("expected an indented block");
      this.i += 1;
      for (;;) {
        const t = this.peek();
        if (t.t === "DEDENT") {
          this.i += 1;
          break;
        }
        if (t.t === "END") break;
        this.statement(body);
      }
    } else this.simpleStatements(body);
    return body;
  }

  simpleStatement() {
    const t = this.peek();
    if (t.t === "NAME") {
      switch (t.v) {
        case "return": {
          this.i += 1;
          const value = this.startsExpr() || this.isOp("*") ? this.starExpressions() : null;
          return N("Return", t.line, { value });
        }
        case "pass":
          this.i += 1;
          return N("Pass", t.line, {});
        case "break":
          this.i += 1;
          return N("Break", t.line, {});
        case "continue":
          this.i += 1;
          return N("Continue", t.line, {});
        case "raise": {
          this.i += 1;
          let exc = null;
          let cause = null;
          if (this.startsExpr()) {
            exc = this.expression();
            if (this.eatKw("from")) cause = this.expression();
          }
          return N("Raise", t.line, { exc, cause });
        }
        case "global":
        case "nonlocal": {
          this.i += 1;
          const names = [this.expectName().v];
          while (this.eatOp(",")) names.push(this.expectName().v);
          return N(t.v === "global" ? "Global" : "Nonlocal", t.line, { names });
        }
        case "del": {
          this.i += 1;
          const first = this.peek();
          const targets = [];
          for (;;) {
            targets.push(this.assignTo(this.bitOr(), "Del"));
            if (!this.eatOp(",")) break;
            if (!this.startsExpr()) break;
          }
          void first;
          return N("Delete", t.line, { targets });
        }
        case "assert": {
          this.i += 1;
          const test = this.expression();
          const msg = this.eatOp(",") ? this.expression() : null;
          return N("Assert", t.line, { test, msg });
        }
        case "import":
          return this.importStatement();
        case "from":
          return this.fromStatement();
        case "yield": {
          const value = this.yieldExpr();
          return N("Expr", t.line, { value });
        }
        case "type": {
          if (this.isName(1) && (this.isOp("=", 2) || this.isOp("[", 2))) {
            this.i += 1;
            const name = this.take();
            const params = this.isOp("[") ? this.typeParams() : [];
            this.expectOp("=");
            const value = this.expression();
            return N("TypeAlias", t.line, { name: N("Name", name.line, { id: name.v, ctx: "Store" }), type_params: params, value });
          }
          break;
        }
        default:
      }
    }
    return this.expressionStatement();
  }

  rhs() {
    return this.isKw("yield") ? this.yieldExpr() : this.starExpressions();
  }

  expressionStatement() {
    const first = this.peek();
    const e = this.starExpressions();
    const t = this.peek();
    if (t.t === "OP") {
      if (t.v === "=") {
        const targets = [e];
        let value = null;
        while (this.eatOp("=")) {
          value = this.rhs();
          if (this.isOp("=")) targets.push(value);
        }
        for (const target of targets) this.assignTo(target, "Store");
        return N("Assign", first.line, { targets, value, type_comment: null });
      }
      if (AUG[t.v]) {
        if (e._ !== "Name" && e._ !== "Attribute" && e._ !== "Subscript") fail("illegal expression for augmented assignment");
        this.i += 1;
        const value = this.rhs();
        e.ctx = "Store";
        return N("AugAssign", first.line, { target: e, op: AUG[t.v], value });
      }
      if (t.v === ":") {
        if (e._ !== "Name" && e._ !== "Attribute" && e._ !== "Subscript") fail("illegal target for annotation");
        this.i += 1;
        const annotation = this.expression();
        const value = this.eatOp("=") ? this.rhs() : null;
        e.ctx = "Store";
        return N("AnnAssign", first.line, { target: e, annotation, value, simple: e._ === "Name" && !e.paren ? 1 : 0 });
      }
    }
    return N("Expr", first.line, { value: e });
  }

  dotted() {
    let name = this.expectName().v;
    while (this.isOp(".")) {
      this.i += 1;
      name += "." + this.expectName().v;
    }
    return name;
  }

  importStatement() {
    const t = this.take();
    const names = [];
    for (;;) {
      const first = this.peek();
      const name = this.dotted();
      const asname = this.eatKw("as") ? this.expectName().v : null;
      names.push(N("alias", first.line, { name, asname }));
      if (!this.eatOp(",")) break;
    }
    return N("Import", t.line, { names });
  }

  fromStatement() {
    const t = this.take();
    let level = 0;
    for (;;) {
      if (this.isOp(".")) level += 1;
      else if (this.isOp("...")) level += 3;
      else break;
      this.i += 1;
    }
    let module = null;
    if (!this.isKw("import")) module = this.dotted();
    else if (!level) fail("invalid syntax");
    this.expectKw("import");
    const names = [];
    if (this.isOp("*")) {
      const s = this.take();
      names.push(N("alias", s.line, { name: "*", asname: null }));
    } else {
      const paren = this.eatOp("(");
      for (;;) {
        const first = this.expectName();
        const asname = this.eatKw("as") ? this.expectName().v : null;
        names.push(N("alias", first.line, { name: first.v, asname }));
        if (!this.eatOp(",")) break;
        if (paren && this.isOp(")")) break;
        if (!paren && !this.isName()) fail("trailing comma not allowed without surrounding parentheses");
      }
      if (paren) this.expectOp(")");
    }
    if (module === "__future__" && level === 0 && names.some((a) => a.name === "barry_as_FLUFL")) this.barry = true;
    return N("ImportFrom", t.line, { module, names, level });
  }

  ifStatement() {
    const t = this.take();
    const test = this.namedExpression();
    const body = this.block();
    let orelse = [];
    if (this.isKw("elif")) orelse = [this.ifStatement()];
    else if (this.isKw("else")) {
      this.i += 1;
      orelse = this.block();
    }
    return N("If", t.line, { test, body, orelse });
  }

  whileStatement() {
    const t = this.take();
    const test = this.namedExpression();
    const body = this.block();
    let orelse = [];
    if (this.eatKw("else")) orelse = this.block();
    return N("While", t.line, { test, body, orelse });
  }

  forStatement(isAsync, start) {
    this.expectKw("for");
    const target = this.targets("Store");
    this.expectKw("in");
    const iter = this.starExpressions();
    const body = this.block();
    let orelse = [];
    if (this.eatKw("else")) orelse = this.block();
    return N(isAsync ? "AsyncFor" : "For", start.line, { target, iter, body, orelse, type_comment: null });
  }

  tryStatement() {
    const t = this.take();
    const body = this.block();
    const handlers = [];
    let star = null;
    while (this.isKw("except")) {
      const h = this.take();
      const isStar = this.eatOp("*");
      if (star !== null && star !== isStar) fail("cannot have both 'except' and 'except*' on the same 'try'");
      star = isStar;
      let type = null;
      let name = null;
      if (!this.isOp(":")) {
        const first = this.peek();
        type = this.expression();
        if (this.isOp(",")) {
          const elts = [type];
          while (this.eatOp(",")) {
            if (this.isOp(":")) break;
            elts.push(this.expression());
          }
          type = N("Tuple", first.line, { elts, ctx: "Load" });
          if (this.isKw("as")) fail("multiple exception types must be parenthesized when using 'as'");
        } else if (this.eatKw("as")) name = this.expectName().v;
      } else if (isStar) fail("expected one or more exception types");
      handlers.push(N("ExceptHandler", h.line, { type, name, body: this.block() }));
    }
    let orelse = [];
    let finalbody = [];
    if (handlers.length && this.eatKw("else")) orelse = this.block();
    if (this.eatKw("finally")) finalbody = this.block();
    if (!handlers.length && !finalbody.length) fail("expected 'except' or 'finally' block");
    return N(star ? "TryStar" : "Try", t.line, { body, handlers, orelse, finalbody });
  }

  withItem(parenthesized) {
    const context = this.expression();
    let vars = null;
    if (this.eatKw("as")) {
      const first = this.peek();
      let target = this.targetElement();
      if (this.isOp(",") && !parenthesized) target = target; // the comma belongs to the next item
      void first;
      vars = this.assignTo(target, "Store");
      if (!(this.isOp(",") || this.isOp(")") || this.isOp(":"))) fail("invalid syntax");
    }
    return { _: "withitem", context_expr: context, optional_vars: vars };
  }

  withStatement(isAsync, start) {
    this.expectKw("with");
    let items = null;
    if (this.isOp("(")) {
      const mark = this.i;
      try {
        this.i += 1;
        const found = [];
        for (;;) {
          found.push(this.withItem(true));
          if (!this.eatOp(",")) break;
          if (this.isOp(")")) break;
        }
        this.expectOp(")");
        if (!this.isOp(":")) fail("invalid syntax");
        items = found;
      } catch (error) {
        if (!(error instanceof PySyntax)) throw error;
        this.i = mark;
      }
    }
    if (items === null) {
      items = [];
      for (;;) {
        items.push(this.withItem(false));
        if (!this.eatOp(",")) break;
      }
    }
    const body = this.block();
    return N(isAsync ? "AsyncWith" : "With", start.line, { items, body, type_comment: null });
  }

  typeParams() {
    this.expectOp("[");
    const out = [];
    for (;;) {
      const t = this.peek();
      if (this.eatOp("*")) {
        const name = this.expectName();
        const def = this.eatOp("=") ? this.starExpression() : null;
        out.push(N("TypeVarTuple", t.line, { name: name.v, default_value: def }));
      } else if (this.eatOp("**")) {
        const name = this.expectName();
        const def = this.eatOp("=") ? this.expression() : null;
        out.push(N("ParamSpec", t.line, { name: name.v, default_value: def }));
      } else {
        const name = this.expectName();
        const bound = this.eatOp(":") ? this.expression() : null;
        const def = this.eatOp("=") ? this.expression() : null;
        out.push(N("TypeVar", t.line, { name: name.v, bound, default_value: def }));
      }
      if (!this.eatOp(",")) break;
      if (this.isOp("]")) break;
    }
    this.expectOp("]");
    return out;
  }

  funcDef(isAsync, start, decorators) {
    this.expectKw("def");
    const name = this.expectName();
    const typeParams = this.isOp("[") ? this.typeParams() : [];
    this.expectOp("(");
    const args = this.parameters(false);
    this.expectOp(")");
    const returns = this.eatOp("->") ? this.expression() : null;
    const body = this.block();
    return N(isAsync ? "AsyncFunctionDef" : "FunctionDef", start.line, {
      name: name.v, args, body, decorator_list: decorators, returns, type_comment: null, type_params: typeParams,
    });
  }

  classDef(start, decorators) {
    this.take();
    const name = this.expectName();
    const typeParams = this.isOp("[") ? this.typeParams() : [];
    let bases = [];
    let keywords = [];
    if (this.isOp("(")) {
      const open = this.take();
      let genexp;
      [bases, keywords, genexp] = this.callArguments(open);
      if (genexp) fail("invalid syntax");
    }
    const body = this.block();
    return N("ClassDef", start.line, { name: name.v, bases, keywords, body, decorator_list: decorators, type_params: typeParams });
  }

  decorated() {
    const decorators = [];
    while (this.isOp("@")) {
      this.i += 1;
      decorators.push(this.namedExpression());
      if (this.peek().t !== "NEWLINE") fail("invalid syntax");
      this.i += 1;
    }
    const t = this.peek();
    if (this.isKw("def")) return this.funcDef(false, t, decorators);
    if (this.isKw("class")) return this.classDef(t, decorators);
    if (this.isKw("async") && this.isKw("def", 1)) {
      this.i += 1;
      return this.funcDef(true, t, decorators);
    }
    fail("invalid syntax");
    return null;
  }

  // ------------------------------------------------------------------------------------------ match

  matchStatement() {
    const t = this.take();
    const first = this.peek();
    let subject = this.starNamedExpression();
    if (this.isOp(",")) {
      const elts = [subject];
      while (this.eatOp(",")) {
        if (this.isOp(":")) break;
        elts.push(this.starNamedExpression());
      }
      subject = N("Tuple", first.line, { elts, ctx: "Load" });
    } else if (subject._ === "Starred") fail("invalid syntax");
    this.expectOp(":");
    if (this.peek().t !== "NEWLINE") fail("invalid syntax");
    this.i += 1;
    if (this.peek().t !== "INDENT") fail("expected an indented block");
    this.i += 1;
    const cases = [];
    while (this.isKw("case")) {
      this.i += 1;
      const pattern = this.patterns();
      const guard = this.eatKw("if") ? this.namedExpression() : null;
      cases.push({ _: "match_case", pattern, guard, body: this.block() });
    }
    if (!cases.length) fail("invalid syntax");
    if (this.peek().t === "DEDENT") this.i += 1;
    else if (this.peek().t !== "END") fail("invalid syntax");
    return N("Match", t.line, { subject, cases });
  }

  patterns() {
    const first = this.peek();
    const one = this.maybeStar();
    if (!this.isOp(",")) {
      if (one._ === "MatchStar") fail("invalid syntax");
      return one;
    }
    const items = [one];
    while (this.eatOp(",")) {
      if (this.isOp(":") || this.isKw("if")) break;
      items.push(this.maybeStar());
    }
    return N("MatchSequence", first.line, { patterns: items });
  }

  maybeStar() {
    if (this.isOp("*")) {
      const t = this.take();
      const name = this.expectName();
      return N("MatchStar", t.line, { name: name.v === "_" ? null : name.v });
    }
    return this.pattern();
  }

  pattern() {
    this.enter();
    try {
      const first = this.peek();
      const p = this.orPattern();
      if (this.eatKw("as")) {
        const name = this.expectName();
        if (name.v === "_") fail("cannot use '_' as a target");
        return N("MatchAs", first.line, { pattern: p, name: name.v });
      }
      return p;
    } finally {
      this.leave();
    }
  }

  orPattern() {
    const first = this.peek();
    const one = this.closedPattern();
    if (!this.isOp("|")) return one;
    const patterns = [one];
    while (this.eatOp("|")) patterns.push(this.closedPattern());
    return N("MatchOr", first.line, { patterns });
  }

  signedNumber() {
    const t = this.peek();
    if (this.isOp("-")) {
      this.i += 1;
      const n = this.peek();
      if (n.t !== "NUM") fail("invalid syntax");
      this.i += 1;
      return N("UnaryOp", t.line, { op: "USub", operand: N("Constant", n.line, { value: numberValue(n), kind: null }) });
    }
    if (t.t !== "NUM") fail("invalid syntax");
    this.i += 1;
    return N("Constant", t.line, { value: numberValue(t), kind: null });
  }

  literalNumber() {
    const first = this.peek();
    const left = this.signedNumber();
    if (this.isOp("+") || this.isOp("-")) {
      const op = this.take().v === "+" ? "Add" : "Sub";
      const n = this.peek();
      if (n.t !== "NUM" || n.kind !== "complex") fail("invalid syntax");
      this.i += 1;
      return N("BinOp", first.line, { left, op, right: N("Constant", n.line, { value: numberValue(n), kind: null }) });
    }
    return left;
  }

  closedPattern() {
    const t = this.peek();
    if (t.t === "NUM" || this.isOp("-")) return N("MatchValue", t.line, { value: this.literalNumber() });
    if (t.t === "STR") {
      const s = this.strings();
      if (s._ !== "Constant") fail("patterns may only match literals and attribute lookups");
      return N("MatchValue", t.line, { value: s });
    }
    if (t.t === "NAME") {
      if (t.v === "None" || t.v === "True" || t.v === "False") {
        this.i += 1;
        return N("MatchSingleton", t.line, { value: { k: t.v === "None" ? "None" : "bool", v: t.v === "True" } });
      }
      if (KEYWORDS.has(t.v)) fail("invalid syntax");
      // a name, a dotted name, or a class pattern
      this.i += 1;
      let e = N("Name", t.line, { id: t.v, ctx: "Load" });
      let dotted = false;
      while (this.isOp(".")) {
        this.i += 1;
        const attr = this.expectName();
        e = N("Attribute", t.line, { value: e, attr: attr.v, ctx: "Load" });
        dotted = true;
      }
      if (this.isOp("(")) return this.classPattern(e, t);
      if (dotted) return N("MatchValue", t.line, { value: e });
      if (t.v === "_") return N("MatchAs", t.line, { pattern: null, name: null });
      return N("MatchAs", t.line, { pattern: null, name: t.v });
    }
    if (t.t === "OP") {
      if (t.v === "(" || t.v === "[") return this.sequencePattern(t);
      if (t.v === "{") return this.mappingPattern(t);
    }
    fail("invalid syntax");
    return null;
  }

  sequencePattern(open) {
    this.i += 1;
    const close = open.v === "(" ? ")" : "]";
    if (this.eatOp(close)) return N("MatchSequence", open.line, { patterns: [] });
    const first = this.maybeStar();
    if (open.v === "(" && this.isOp(")") && first._ !== "MatchStar") {
      this.i += 1;
      return first; // a group
    }
    const items = [first];
    let comma = false;
    while (this.eatOp(",")) {
      comma = true;
      if (this.isOp(close)) break;
      items.push(this.maybeStar());
    }
    this.expectOp(close);
    if (open.v === "(" && !comma && items.length === 1 && items[0]._ !== "MatchStar") return items[0];
    return N("MatchSequence", open.line, { patterns: items });
  }

  mappingPattern(open) {
    this.i += 1;
    const keys = [];
    const patterns = [];
    let rest = null;
    while (!this.isOp("}")) {
      if (this.eatOp("**")) {
        rest = this.expectName().v;
      } else {
        const t = this.peek();
        let key;
        if (t.t === "NUM" || this.isOp("-")) key = this.literalNumber();
        else if (t.t === "STR") {
          key = this.strings();
          if (key._ !== "Constant") fail("patterns may only match literals and attribute lookups");
        } else if (t.t === "NAME" && (t.v === "None" || t.v === "True" || t.v === "False")) key = this.atom();
        else if (this.isName()) {
          this.i += 1;
          key = N("Name", t.line, { id: t.v, ctx: "Load" });
          if (!this.isOp(".")) fail("mapping pattern keys may only match literals and attribute lookups");
          while (this.eatOp(".")) {
            const attr = this.expectName();
            key = N("Attribute", t.line, { value: key, attr: attr.v, ctx: "Load" });
          }
        } else fail("invalid syntax");
        this.expectOp(":");
        keys.push(key);
        patterns.push(this.pattern());
      }
      if (!this.eatOp(",")) break;
    }
    this.expectOp("}");
    return N("MatchMapping", open.line, { keys, patterns, rest });
  }

  classPattern(cls, start) {
    this.i += 1;
    const patterns = [];
    const attrs = [];
    const kwPatterns = [];
    while (!this.isOp(")")) {
      if (this.isName() && this.isOp("=", 1)) {
        attrs.push(this.take().v);
        this.i += 1;
        kwPatterns.push(this.pattern());
      } else {
        if (attrs.length) fail("positional patterns follow keyword patterns");
        patterns.push(this.pattern());
      }
      if (!this.eatOp(",")) break;
    }
    this.expectOp(")");
    return N("MatchClass", start.line, { cls, patterns, kwd_attrs: attrs, kwd_patterns: kwPatterns });
  }
}

// The value of a number token, as a tagged constant.
function numberValue(t) {
  const text = t.v.replace(/_/g, "");
  if (t.kind === "int") {
    const lower = lowerPinned(text);
    if (lower.startsWith("0x") || lower.startsWith("0o") || lower.startsWith("0b")) return { k: "int", v: BigInt(lower) };
    return { k: "int", v: BigInt(text) };
  }
  if (t.kind === "float") return { k: "float", v: Number(text) };
  return { k: "complex", v: Number(text.slice(0, -1)) };
}

// ------------------------------------------------------------------------------------------ f-strings

const CONVERSIONS = { s: 115, r: 114, a: 97 };
const MAX_FIELD_NEST = 150;
let nest = 0;

// The parts of an f-string (or t-string) body from `i`: [{ lit }, { node }] and where it ends. `spec` is true inside a
// format spec, where a '}' ends the part and is not consumed.
function fstringParts(source, i, quote, triple, raw, isTemplate, spec = false) {
  const s = source.text;
  const parts = [];
  let lit = "";
  const flush = () => {
    if (lit) parts.push({ lit });
    lit = "";
  };
  const piece = (text) => {
    lit += raw ? text : decode(text, false, false);
  };
  let from = i;
  const take = (upTo) => {
    if (upTo > from) piece(s.slice(from, upTo));
    from = upTo;
  };
  for (;;) {
    if (i >= s.length) fail("unterminated f-string literal");
    const c = s[i];
    if (!spec && c === quote && (!triple || (s[i + 1] === quote && s[i + 2] === quote))) {
      take(i);
      flush();
      return { parts, end: i + (triple ? 3 : 1) };
    }
    if (spec && c === quote && !triple) {
      take(i);
      flush();
      return { parts, end: i, closedByQuote: true };
    }
    if (c === "\n" && !triple) fail("unterminated f-string literal");
    if (c === "\\") {
      if (s[i + 1] === "{" || s[i + 1] === "}") {
        i += 1;
        continue;
      }
      if (!raw && s[i + 1] === "N" && s[i + 2] === "{") {
        const close = s.indexOf("}", i);
        if (close < 0) fail("malformed \\N character escape");
        i = close + 1;
        continue;
      }
      i += 2;
      continue;
    }
    if (c === "{") {
      if (!spec && s[i + 1] === "{") {
        take(i + 1); // the literal brace, once
        i += 2;
        from = i;
        continue;
      }
      take(i);
      const field = parseField(source, i, quote, triple, raw, isTemplate, spec);
      lit += field.debug;
      flush();
      parts.push({ node: field.node });
      i = field.end;
      from = i;
      continue;
    }
    if (c === "}") {
      if (spec) {
        take(i);
        flush();
        return { parts, end: i };
      }
      if (s[i + 1] === "}") {
        take(i + 1);
        i += 2;
        from = i;
        continue;
      }
      fail("single '}' is not allowed");
    }
    i += 1;
  }
}

// The replacement field whose '{' is at `at`: its node and the offset after its '}'.
function parseField(source, at, quote, triple, raw, isTemplate, inSpec) {
  const s = source.text;
  nest += 1;
  try {
    if (nest > MAX_FIELD_NEST) fail("too many nested f-strings");
    const lexer = new Lexer(source, at + 1, "field");
    const parser = new Parser(lexer);
    const first = parser.peek();
    if (first.t === "END" || (first.t === "OP" && (first.v === "}" || first.v === ":" || first.v === "!" || first.v === "="))) {
      fail("f-string: valid expression required before '}'");
    }
    const line = first.line;
    const value = parser.isKw("yield") ? parser.yieldExpr() : parser.starExpressions();
    let t = parser.peek();
    let debugText = "";
    if (t.t === "OP" && t.v === "=") {
      parser.i += 1;
      t = parser.peek();
      debugText = s.slice(at + 1, t.at);
    }
    let conversion = -1;
    let formatSpec = null;
    if (t.t === "OP" && t.v === "!") {
      const letter = s[t.end];
      if (!(letter in CONVERSIONS)) fail("f-string: invalid conversion character");
      conversion = CONVERSIONS[letter];
      let k = t.end + 1;
      while (s[k] === " " || s[k] === "\t" || s[k] === "\n" || s[k] === "\x0c") k += 1;
      if (s[k] !== "}" && s[k] !== ":") fail("f-string: expecting '}'");
      if (s[k] === ":") {
        const made = fstringParts(source, k + 1, quote, triple, raw, false, true);
        formatSpec = N("JoinedStr", line, { values: specValues(made.parts, line) });
        k = made.end;
      }
      if (s[k] !== "}") fail("f-string: expecting '}'");
      return finish(value, conversion, formatSpec, debugText, k + 1, line, isTemplate, s.slice(at + 1, t.at));
    }
    if (t.t === "OP" && t.v === ":") {
      const made = fstringParts(source, t.end, quote, triple, raw, false, true);
      if (made.closedByQuote) fail("f-string: expecting '}'");
      formatSpec = N("JoinedStr", line, { values: specValues(made.parts, line) });
      const k = made.end;
      if (s[k] !== "}") fail("f-string: expecting '}'");
      return finish(value, conversion, formatSpec, debugText, k + 1, line, isTemplate, s.slice(at + 1, t.at));
    }
    if (t.t === "OP" && t.v === "}") {
      return finish(value, conversion, null, debugText, t.end, line, isTemplate, s.slice(at + 1, t.at));
    }
    fail("f-string: expecting '}'");
    return null;
  } finally {
    nest -= 1;
  }
  void inSpec;
}

function specValues(parts, line) {
  const out = [];
  for (const part of parts) {
    if (part.lit !== undefined) out.push(N("Constant", line, { value: { k: "str", v: part.lit }, kind: null }));
    else out.push(part.node);
  }
  return out;
}

function finish(value, conversion, formatSpec, debugText, end, line, isTemplate, text) {
  let conv = conversion;
  if (debugText && conv === -1 && formatSpec === null) conv = 114;
  const node = isTemplate
    ? N("Interpolation", line, { value, str: text, conversion: conv, format_spec: formatSpec })
    : N("FormattedValue", line, { value, conversion: conv, format_spec: formatSpec });
  return { node, end, debug: debugText, line };
}

// A field with a debug mark (`{x=}`) also gives its text as a literal part.
const baseFieldParts = fstringParts;

setFStringHook((source, body, quote, triple, raw, isTemplate) => {
  const made = baseFieldParts(source, body, quote, triple, raw, isTemplate, false);
  return made;
});

const FUTURES = new Set([
  "nested_scopes", "generators", "division", "absolute_import", "with_statement", "print_function", "unicode_literals",
  "barry_as_FLUFL", "generator_stop", "annotations",
]);

// The leading `from __future__ import` statements name features that exist (a docstring may come first).
function checkFutures(tree) {
  const body = tree.body;
  for (let i = 0; i < body.length; i++) {
    const s = body[i];
    if (s._ === "ImportFrom" && s.module === "__future__" && s.level === 0) {
      for (const a of s.names) if (!FUTURES.has(a.name)) fail(`future feature ${a.name} is not defined`);
    } else if (i === 0 && s._ === "Expr" && s.value._ === "Constant" && s.value.value.k === "str") continue;
    else break;
  }
}

// The tree of a Python source text, or null when it is not a program.
export function parsePython(text, debug = false) {
  // a lone surrogate cannot be encoded as the source
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text)) return null;
  if (text.includes("\0")) return null;
  try {
    const source = new Source(text);
    nest = 0;
    const parser = new Parser(new Lexer(source));
    const tree = parser.file();
    checkFutures(tree);
    return tree;
  } catch (error) {
    if (!debug && (error instanceof PySyntax || error instanceof RangeError)) return null;
    throw error;
  }
}

export { identifier };
