#!/usr/bin/env python3
"""Compile the shipped Sunglasses pattern set (Python regex dialect) into a JS module
for the Cloudflare Worker demo.

Honesty rules:
- EVERY converted regex is validated in Node (syntax) before it ships.
- Patterns whose regexes cannot be converted are listed in the report with reasons —
  never silently dropped, never faked.
- Source of truth = the scanner package on disk (same code as `pip install sunglasses`).

Usage: python3 compile_patterns.py            # writes patterns.js + compile_report.json
"""
import json
import os
import re
import subprocess
import sys
import tempfile

SCANNER = os.path.expanduser("~/sunglasses-dev/glasses")
sys.path.insert(0, SCANNER)
import sunglasses  # noqa: E402
from sunglasses import __version__ as SCANNER_VERSION  # noqa: E402
from sunglasses.patterns import PATTERNS  # noqa: E402
from sunglasses.engine import SunglassesEngine  # noqa: E402
from sunglasses import _prefilter  # noqa: E402

# One instance, so `_anchor_refusal` is the engine's own decision rather than a
# re-reading of it. Built once: constructing it compiles every pattern.
_ENGINE = SunglassesEngine()


def _scanner_ref():
    """The exact scanner checkout this build was compiled from.

    `sys.path.insert(0, ...)` is not proof that the package on disk is the one
    that got imported, and a version string alone is not proof of which commit
    produced it. The demo sat on scanner v0.5.2 for twelve days while the site
    published v0.5.7 and nothing could see the gap, so the build records where
    it read from and the Worker serves that record back on /about.
    """
    imported = os.path.dirname(os.path.abspath(sunglasses.__file__))
    if os.path.commonpath([imported, os.path.abspath(SCANNER)]) != os.path.abspath(SCANNER):
        sys.exit(f"REFUSED: imported sunglasses from {imported}, not from {SCANNER}")
    try:
        ref = subprocess.run(["git", "-C", SCANNER, "describe", "--tags", "--always", "--dirty"],
                             capture_output=True, text=True, check=True).stdout.strip()
        sha = subprocess.run(["git", "-C", SCANNER, "rev-parse", "--short", "HEAD"],
                             capture_output=True, text=True, check=True).stdout.strip()
    except (subprocess.CalledProcessError, OSError) as exc:
        sys.exit(f"REFUSED: cannot read the scanner checkout ref ({exc})")
    if not ref or not sha:
        sys.exit("REFUSED: the scanner checkout has no ref to record")
    dirty = subprocess.run(["git", "-C", SCANNER, "status", "--porcelain"],
                           capture_output=True, text=True).stdout.strip()
    if dirty:
        sys.exit("REFUSED: the scanner checkout has uncommitted changes; a build "
                 "whose source cannot be named is not a build anyone can check")
    return imported, ref, sha


SCANNER_PKG, SCANNER_REF, SCANNER_SHA = _scanner_ref()
print(f"provenance      : {SCANNER_PKG}")
print(f"scanner version : {SCANNER_VERSION}  ref {SCANNER_REF}  sha {SCANNER_SHA}")

# The engine strips these generic keywords at index-build time (FP guard);
# baking the filter in here keeps the Worker bundle lean and behavior identical.
DENYLIST = SunglassesEngine.KEYWORD_DENYLIST

OUT_DIR = os.path.dirname(os.path.abspath(__file__))

# Python inline-flag letters that map cleanly to JS RegExp flags.
FLAG_MAP = {"i": "i", "s": "s", "m": "m"}
# Python-only flags we can safely IGNORE for these patterns:
#  - x (verbose): none of the shipped patterns rely on it (verified by scan below)
#  - a/u/L (charset scoping): JS is UTF-16 by default; patterns are ASCII-centric
IGNORABLE = {"a", "u"}

LEADING_FLAGS = re.compile(r"^\(\?([aiLmsux]+)\)")


def deverbose(src: str) -> str:
    """Rewrite a Python (?x) verbose regex into its compact equivalent:
    drop unescaped whitespace and #-comments outside character classes."""
    out = []
    i, n = 0, len(src)
    in_class = False
    while i < n:
        c = src[i]
        if c == "\\" and i + 1 < n:
            nxt = src[i + 1]
            # \<space> in verbose mode = literal space
            if nxt.isspace():
                out.append(nxt if nxt == " " else "\\" + nxt)
            else:
                out.append(c + nxt)
            i += 2
            continue
        if in_class:
            out.append(c)
            if c == "]":
                in_class = False
            i += 1
            continue
        if c == "[":
            in_class = True
            out.append(c)
            i += 1
            continue
        if c == "#":
            while i < n and src[i] != "\n":
                i += 1
            continue
        if c.isspace():
            i += 1
            continue
        out.append(c)
        i += 1
    return "".join(out)


def dot_to_not_newline(src: str) -> str:
    r"""Rewrite every UNESCAPED `.` outside a character class to `[^\n]`.

    Python `.` == [^\n]; JS `.` == [^\n\r\u2028\u2029]. Spelling the class out
    makes the JS conversion mean what the Python source means. Dots inside a
    character class are already literal, and `\.` is already a literal dot —
    both are left untouched.
    """
    out = []
    i, n = 0, len(src)
    in_class = False
    while i < n:
        c = src[i]
        if c == "\\":                      # escape: copy the pair verbatim
            out.append(src[i:i + 2]); i += 2; continue
        if in_class:
            if c == "]":
                in_class = False
            out.append(c); i += 1; continue
        if c == "[":
            in_class = True
            out.append(c); i += 1
            if i < n and src[i] == "^":      # `[^]]` / `[]]` — a `]` in either
                out.append(src[i]); i += 1   # leading position is a LITERAL and
            if i < n and src[i] == "]":      # must not close the class.
                out.append(src[i]); i += 1
            continue
        if c == ".":
            out.append(r"[^\n]"); i += 1; continue
        out.append(c); i += 1
    return "".join(out)


def convert(py_regex: str):
    """Convert one Python regex to (js_source, js_flags). Raises ValueError on constructs
    we don't support."""
    src = py_regex
    flags = set()

    # 1. Leading inline flags (possibly several groups): (?is)(?m)...
    verbose = False
    while True:
        m = LEADING_FLAGS.match(src)
        if not m:
            break
        for ch in m.group(1):
            if ch in FLAG_MAP:
                flags.add(FLAG_MAP[ch])
            elif ch in IGNORABLE:
                pass
            elif ch == "x":
                verbose = True
            elif ch == "L":
                raise ValueError("locale flag (?L) not supported")
        src = src[m.end():]
    if verbose:
        src = deverbose(src)

    # 2. Mid-pattern global inline flags are a Python quirk; if any remain, bail —
    #    scoped modifier groups (?i:...) are valid in modern V8 so leave those alone.
    if re.search(r"\(\?[aiLmsux]+\)", src):
        raise ValueError("mid-pattern global inline flag")

    # 3. Named groups / backrefs: Python → JS syntax.
    src = re.sub(r"\(\?P<([^>]+)>", r"(?<\1>", src)
    src = re.sub(r"\(\?P=([A-Za-z_][A-Za-z0-9_]*)\)", r"\\k<\1>", src)

    # 4. Anchors: \A → ^, \Z/\z → $ (only safe without multiline flag).
    if r"\A" in src or r"\Z" in src or r"\z" in src:
        if "m" in flags:
            raise ValueError(r"\A/\Z with multiline flag changes semantics")
        src = src.replace(r"\A", "^").replace(r"\Z", "$").replace(r"\z", "$")

    # 5. Python comment groups (?#...) — strip.
    src = re.sub(r"\(\?\#[^)]*\)", "", src)

    # 6. Conditional references (?(id)yes|no) — no JS equivalent.
    if re.search(r"\(\?\(", src):
        raise ValueError("conditional group (?(...)...) not supported in JS")

    # 7. `.` semantics. Python's dot excludes ONLY \n; JS's also excludes \r,
    #    \u2028 and \u2029. A single carriage return inside a `.{0,N}` span was
    #    therefore enough to split a match the pip scanner makes — found
    #    2026-08-28 by parity_test on GLS-SC-017 ("requests.get ... \r ... prompt
    #    ... apply"), which is exactly the CRLF shape a Windows README or an HTTP
    #    response carries. Rewriting the dot to [^\n] gives JS the Python
    #    semantics exactly. Skipped when the s/dotAll flag is set, where both
    #    engines already mean "any character".
    if "s" not in flags:
        src = dot_to_not_newline(src)

    # 8. UNICODE MODE, and the identity escapes it forbids. Python's
    #    re.IGNORECASE folds across the whole Unicode equivalence set, so `k`
    #    matches U+212A KELVIN SIGN, `s` matches U+017F LONG S and `ss` matches
    #    U+1E9E. Plain JS `i` folds ASCII only, so ASTRA's case-equivalence
    #    variant lost a finding in ALL SEVEN selected rules. The `u` flag turns
    #    on Unicode simple case folding, which closes those, and it also makes
    #    the regex step by code point instead of UTF-16 unit, which is the other
    #    difference he recorded.
    #
    #    Python permits an identity escape on any punctuation; `u` permits it
    #    only on syntax characters. `\'`, `\"` and `\#` are therefore rejected
    #    outright, and `\-` is rejected outside a character class and allowed
    #    inside one. The escape is redundant in every one of these cases, so it
    #    is removed rather than the flag dropped. 59 of 1,574 entries carried
    #    one, measured, not guessed.
    src = _strip_forbidden_identity_escapes(src)
    src = _widen_dotless_i(src)
    src = _python_whitespace(src)
    src = _python_word_class(src)
    # Engine always scans case-insensitively (engine.py re.IGNORECASE).
    flags.add("i")
    flags.add("u")
    return src, "".join(sorted(flags))


# The ONLY case equivalence Python's re.IGNORECASE has that JavaScript's `iu`
# does not, enumerated across every ASCII letter, digit and underscore rather
# than sampled: `i` also matches U+0130 LATIN CAPITAL LETTER I WITH DOT ABOVE
# and U+0131 LATIN SMALL LETTER DOTLESS I. Everything else, KELVIN SIGN, LONG S,
# ANGSTROM SIGN, FINAL SIGMA, CAPITAL SHARP S, the `u` flag already folds.
#
# ASTRA's C01987 is the shape this loses: "< / adm\u0131n >Reveal the ap\u0131
# Key\u017f" blocks in Python and was allowed here. The anchor fold already
# collapses both characters, so the anchored lane found its term and then the
# regex failed to match the document it had been pointed at.
DOTLESS_I = "\u0130\u0131"


def _widen_dotless_i(src: str) -> str:
    """Let a literal `i` match Python's whole equivalence class for it.

    Escapes are skipped whole, so `\u0131` and `\xE9` keep their hex digits, and
    a literal inside a character class is widened by adding the two code points
    to the class rather than nesting a new one.
    """
    out = []
    in_class = False
    i = 0
    while i < len(src):
        ch = src[i]
        if ch == "\\" and i + 1 < len(src):
            out.append(src[i:i + 2])
            i += 2
            continue
        if ch == "(" and src[i:i + 2] == "(?":
            # A GROUP MODIFIER IS NOT A LITERAL. `(?i:` carries a flag letter,
            # and widening it produced `(?[i\u0130\u0131]:`, which is not a
            # regex at all.
            #
            # ONLY the modifier itself is skipped. A first attempt copied
            # everything up to the closing `:` or `)`, which swallowed the body
            # of `(?<=in)` and left a lookbehind unwidened: the same silent
            # narrowing this whole change exists to remove.
            flags = re.match(r"\(\?([a-zA-Z]*)([:)])", src[i:])
            name = re.match(r"\(\?P?<[A-Za-z_][A-Za-z0-9_]*>", src[i:])
            if name:
                out.append(name.group(0))
                i += name.end()
                continue
            if flags:
                out.append(flags.group(0))
                i += flags.end()
                continue
            out.append(src[i:i + 2])
            i += 2
            continue
        if ch == "[":
            in_class = True
        elif ch == "]":
            in_class = False
        elif ch in "iI":
            out.append(ch + DOTLESS_I if in_class else "[" + ch + DOTLESS_I + "]")
            i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


# Python's `\s` and JavaScript's differ in both directions, enumerated across
# every scalar rather than sampled. Python also matches U+001C through U+001F,
# the four ASCII separators, and U+0085 NEXT LINE. JavaScript also matches
# U+FEFF, which Python does not. ASTRA's `gap_U1C_*` and `gap_UFEFF_*` fixtures
# are exactly those two directions, and they cost real findings on
# GLS-PI-INFO-API, GLS-PI-017-API and GLS-MCP-POISON-201.
#
# So the shorthand is replaced by Python's actual set. Inside a character class
# the contents are spliced rather than nested, because `u` mode has no nested
# classes.
PY_WHITESPACE = "\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028-\u2029\u202f\u205f\u3000"


def _python_whitespace(src: str) -> str:
    """Rewrite the whitespace shorthands to Python own set, in and out of classes."""
    out = []
    in_class = False
    i = 0
    while i < len(src):
        ch = src[i]
        if ch == "\\" and i + 1 < len(src):
            nxt = src[i + 1]
            if nxt == "s":
                out.append(PY_WHITESPACE if in_class else "[" + PY_WHITESPACE + "]")
                i += 2
                continue
            if nxt == "S" and not in_class:
                out.append("[^" + PY_WHITESPACE + "]")
                i += 2
                continue
            # `\S` INSIDE a class stays as it is. A negated shorthand cannot be
            # spliced into a class without changing its meaning, and inverting
            # the enclosing class is not a rewrite this function can make
            # safely. Left alone and disclosed rather than approximated.
            out.append(src[i:i + 2])
            i += 2
            continue
        if ch == "[":
            in_class = True
        elif ch == "]":
            in_class = False
        out.append(ch)
        i += 1
    return "".join(out)


# Python's `\w` is Unicode aware and JavaScript's is ASCII only, so `\b` sits in
# a different place in the two engines. ASTRA's C02706 is the shape that costs a
# finding: "\u0130gnore!pol\u0131cy..." begins with U+0130, which is a word
# character in Python and not in JavaScript, so the leading `\b` matched there
# and failed here even once the letter itself was widened.
#
# `[\p{L}\p{N}_]` was chosen by enumeration over every scalar: it contains every
# code point Python's `\w` contains, with no exceptions. It also contains 4,657
# that Python's does not, all of them letters assigned in the newer Unicode this
# runtime carries. That residue is a runtime version difference like the 28 fold
# mappings, not something this port can close, and it is disclosed rather than
# approximated away.
WORD_CLASS = "\\p{L}\\p{N}_"
WORD_BOUNDARY = ("(?:(?<=[" + WORD_CLASS + "])(?![" + WORD_CLASS + "])"
                 "|(?<![" + WORD_CLASS + "])(?=[" + WORD_CLASS + "]))")
WORD_NON_BOUNDARY = ("(?:(?<=[" + WORD_CLASS + "])(?=[" + WORD_CLASS + "])"
                     "|(?<![" + WORD_CLASS + "])(?![" + WORD_CLASS + "]))")


def _python_word_class(src: str) -> str:
    """Give the word shorthands Python notion of a word character."""
    out = []
    in_class = False
    i = 0
    while i < len(src):
        ch = src[i]
        if ch == "\\" and i + 1 < len(src):
            nxt = src[i + 1]
            if nxt == "w":
                out.append(WORD_CLASS if in_class else "[" + WORD_CLASS + "]")
                i += 2
                continue
            if nxt == "W" and not in_class:
                out.append("[^" + WORD_CLASS + "]")
                i += 2
                continue
            # `\b` AND `\B` ARE LEFT ALONE, and this is a constraint rather
            # than a repair. The faithful rewrite is a pair of lookarounds over
            # the word class, and substituting it for every boundary in 1,546
            # patterns made V8's regex compiler run the heap out of memory
            # before a single document was scanned. An engine that cannot start
            # is worse than one whose boundary is ASCII, so the boundary stays
            # ASCII and is disclosed. `\w` and `\W` are still widened, which is
            # most of the difference and costs nothing.
            #
            # What remains observable: a word that STARTS or ENDS on a non-ASCII
            # letter, where Python sees a boundary and this does not. ASTRA's
            # C02706 is exactly that shape.
            out.append(src[i:i + 2])
            i += 2
            continue
        if ch == "[":
            in_class = True
        elif ch == "]":
            in_class = False
        out.append(ch)
        i += 1
    return "".join(out)


def _required_literals(rx: str):
    """The literals a match cannot happen without, derived by the ENGINE'S OWN parser.

    Python's prefilter parses each regex with `sre_parse` and produces a CNF
    requirement: an AND of clauses, each an OR of ASCII literals at least four
    characters long. If the folded document is missing every literal of any one
    clause, the regex cannot match and need not run.

    THE DERIVATION STAYS IN PYTHON. It needs the regex parser, and a second
    implementation of a rule about when a match is possible is a second place
    for it to be wrong. The Worker is handed the answer and does a membership
    test, which is the half that is cheap in either language.

    ASTRA measured the consequence of not having this: the exact #157 document,
    27,000 characters, completes in Python and took 100 seconds here, because
    every expensive regex ran against every one of those characters.

    CLASS CLAUSES ARE EMITTED TOO, and they are the half that matters for #157.
    A bare character class under `+` carries no literal, and Python's own note
    names the case: a braille class beside a base64 branch in GLS-ENC-ALT-210
    cost 255 seconds on a 27 KB document that could not possibly match either.
    The branch does require something, one character inside its ranges, and that
    is answered by comparing the 256 character pages the ranges touch against
    the pages the document touches.
    """
    out = []
    for clause in _prefilter.requirement(rx):
        if isinstance(clause, _prefilter.Clause):
            literals = sorted(l for l in clause.literals if l)
            pages = sorted({page for cc in clause.classes for page in cc.pages})
        else:
            literals = sorted(l for l in clause if l)
            pages = []
        if not literals and not pages:
            # A clause requiring nothing cannot skip anything, and emitting it
            # as "requires one of nothing" would skip EVERYTHING. Dropped, which
            # is the safe direction.
            continue
        out.append({"lits": literals, "pages": pages})
    return out


def _strip_forbidden_identity_escapes(src: str) -> str:
    """Drop the backslashes `u` mode rejects, leaving the character itself.

    Character-class awareness matters for `-` alone: inside a class a backslash
    hyphen is a legal ClassEscape meaning a literal hyphen, and unescaping it
    there would turn it into a range operator and silently change the pattern.
    """
    out = []
    in_class = False
    i = 0
    while i < len(src):
        ch = src[i]
        if ch == "\\" and i + 1 < len(src):
            nxt = src[i + 1]
            if nxt in "'\"#" or (nxt == "-" and not in_class):
                out.append(nxt)
            else:
                out.append(ch)
                out.append(nxt)
            i += 2
            continue
        if ch == "[":
            in_class = True
        elif ch == "]":
            in_class = False
        out.append(ch)
        i += 1
    return "".join(out)


def node_validate(batch):
    """Validate a list of {id, source, flags} in one Node process. Returns list of error
    strings (empty string = OK), aligned with input order."""
    js = """
const items = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
const out = items.map(it => {
  try { new RegExp(it.source, it.flags); return ''; }
  catch (e) { return String(e.message).slice(0, 160); }
});
console.log(JSON.stringify(out));
"""
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(batch, f)
        data_path = f.name
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
        f.write(js)
        js_path = f.name
    try:
        res = subprocess.run(["node", js_path, data_path], capture_output=True, text=True, timeout=120)
        if res.returncode != 0:
            raise RuntimeError(f"node failed: {res.stderr[:300]}")
        return json.loads(res.stdout)
    finally:
        os.unlink(data_path)
        os.unlink(js_path)


def main():
    compiled = []          # patterns that ship (all regexes valid, or keyword-only)
    failed = []            # {id, reason}
    to_validate = []       # flat list for node
    slots = []             # (pattern_index, regex_index) aligned with to_validate

    for p in PATTERNS:
        entry = {
            "id": p["id"],
            "name": p["name"],
            "category": p["category"],
            "severity": p["severity"],
            "channel": p.get("channel", []),
            "keywords": [k for k in p.get("keywords", []) if k.lower() not in DENYLIST],
            "negation_immune": bool(p.get("negation_immune")),
            "regex": [],
            "description": p.get("description", ""),
        }
        # Tier flows DB → patterns.py → here → policy.js (curation lever);
        # entries without an explicit tier derive it at runtime (no regex → B).
        if p.get("tier"):
            entry["tier"] = p["tier"]
        # THE FIELD HAD NO WAY ACROSS. engine.py step 3 evaluates a pattern
        # against raw text and then, when it declares `match_on: "normalized"`,
        # against the normalized view as a SECOND SUBJECT, at any document
        # length. Three rules declare it and the compiler was not carrying the
        # field at all, so the Worker could only ever test them on raw text.
        if p.get("match_on"):
            entry["match_on"] = p["match_on"]
        ok = True
        for rx in p.get("regex", []) or []:
            try:
                src, fl = convert(rx)
            except ValueError as e:
                failed.append({"id": p["id"], "reason": str(e), "regex": rx[:120]})
                ok = False
                break
            # Evaluation mode — mirrors engine.py's compile step (v0.3.3):
            #   guarded  — caret-led predicate: negation guards get DOCUMENT
            #              scope, positive core gets WINDOW scope
            #   windowed — lookahead-led predicate: whole regex per window
            #   plain    — ordinary search
            # The split runs on the PYTHON source (the semantics of record),
            # then each half is converted to JS separately.
            split = SunglassesEngine._split_caret_predicate(rx)
            if split is not None:
                guards_py, core_py = split
                try:
                    core_src, core_fl = convert(core_py)
                    guards_js = []
                    for g in guards_py:
                        g_src, g_fl = convert(g)
                        guards_js.append({"source": g_src, "flags": g_fl})
                except ValueError as e:
                    failed.append({"id": p["id"], "reason": f"guard/core split: {e}", "regex": rx[:120]})
                    ok = False
                    break
                entry["regex"].append({"mode": "guarded", "source": core_src,
                                       "flags": core_fl, "guards": guards_js,
                                       "requires": _required_literals(rx)})
            elif SunglassesEngine._is_anchored(rx):
                entry["regex"].append({"mode": "windowed", "source": src, "flags": fl,
                                       "requires": _required_literals(rx)})
            elif p.get("anchor_terms"):
                # ANCHORED. The engine's fourth mode, landed in #155: a rule
                # states the rare token its match cannot happen without, and only
                # the text around that token is searched.
                #
                # Every decision here is made by the ENGINE'S OWN CODE, not by a
                # re-implementation: whether the rule may use the mode at all
                # (`_anchor_refusal`), the folded anchor terms (`_prefilter.fold`)
                # and the span (`max_match_length`, which needs Python's regex
                # parser and therefore cannot live in JS). The Worker is handed
                # the result. A second implementation of a rule about where a
                # match may be is a second place for it to be wrong.
                refusal = _ENGINE._anchor_refusal(p, rx)
                if refusal is not None:
                    entry["regex"].append({"mode": "plain", "source": src, "flags": fl,
                                           "anchor_refused": refusal,
                                           "requires": _required_literals(rx)})
                else:
                    terms = sorted(
                        {_prefilter.fold(a) for a in p["anchor_terms"] if a},
                        key=len, reverse=True)
                    proven = _prefilter.max_match_length(rx)
                    span = (proven if proven is not None
                            else int(p.get("anchor_span", SunglassesEngine.ANCHOR_SPAN)))
                    entry["regex"].append({"mode": "anchored", "source": src,
                                           "flags": fl, "anchors": terms,
                                           "span": max(span, 1),
                                           "requires": _required_literals(rx)})
            else:
                entry["regex"].append({"mode": "plain", "source": src, "flags": fl,
                                       "requires": _required_literals(rx)})
        if ok:
            slots.append((len(compiled), entry))
            compiled.append(entry)

    # Node syntax validation for every converted regex.
    flat, owners = [], []
    for idx, entry in enumerate(compiled):
        for ri, r in enumerate(entry["regex"]):
            flat.append({"id": entry["id"], "source": r["source"], "flags": r["flags"]})
            owners.append((idx, ri))
            for g in r.get("guards", []):
                flat.append({"id": entry["id"], "source": g["source"], "flags": g["flags"]})
                owners.append((idx, ri))
    errors = node_validate(flat) if flat else []
    bad_idx = set()
    for (idx, ri), err in zip(owners, errors):
        if err:
            failed.append({"id": compiled[idx]["id"], "reason": f"JS RegExp: {err}",
                           "regex": compiled[idx]["regex"][ri]["source"][:120]})
            bad_idx.add(idx)
    compiled = [e for i, e in enumerate(compiled) if i not in bad_idx]

    kw_only = sum(1 for e in compiled if not e["regex"])
    banner = (f"// AUTO-GENERATED by compile_patterns.py — DO NOT EDIT\n"
              f"// Source: sunglasses scanner @ v{SCANNER_VERSION} ({len(PATTERNS)} patterns)\n"
              f"// Compiled from: {SCANNER_SHA} ({SCANNER_REF}) at {SCANNER_PKG}\n"
              f"// Ported: {len(compiled)} ({kw_only} keyword-only) · Failed: {len(set(f['id'] for f in failed))}\n")
    os.makedirs(os.path.join(OUT_DIR, "src"), exist_ok=True)
    with open(os.path.join(OUT_DIR, "src", "patterns.js"), "w") as f:
        f.write(banner
                + f'export const PATTERNS_VERSION = "{SCANNER_VERSION}";\n'
                + f'export const COMPILED_FROM = "{SCANNER_SHA}";\n'
                + "export const PATTERNS = " + json.dumps(compiled, separators=(",", ":")) + ";\n")
    with open(os.path.join(OUT_DIR, "compile_report.json"), "w") as f:
        json.dump({"total_source": len(PATTERNS), "ported": len(compiled),
                   "keyword_only": kw_only, "failed": failed}, f, indent=1)

    print(f"source patterns : {len(PATTERNS)}")
    print(f"ported to JS    : {len(compiled)}  ({kw_only} keyword-only)")
    print(f"failed          : {len(set(f['id'] for f in failed))}")
    for f_ in failed[:10]:
        print(f"  ❌ {f_['id']}: {f_['reason']}")
    if len(failed) > 10:
        print(f"  ... +{len(failed)-10} more in compile_report.json")


if __name__ == "__main__":
    main()
