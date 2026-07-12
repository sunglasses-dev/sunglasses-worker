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
from sunglasses import __version__ as SCANNER_VERSION  # noqa: E402
from sunglasses.patterns import PATTERNS  # noqa: E402
from sunglasses.engine import SunglassesEngine  # noqa: E402

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

    # Engine always scans case-insensitively (engine.py re.IGNORECASE).
    flags.add("i")
    return src, "".join(sorted(flags))


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
        ok = True
        for rx in p.get("regex", []) or []:
            try:
                src, fl = convert(rx)
            except ValueError as e:
                failed.append({"id": p["id"], "reason": str(e), "regex": rx[:120]})
                ok = False
                break
            # Engine's _is_anchored: lookahead-led whole-document predicates are
            # evaluated once at position 0 (ReDoS guard) — flag them for the JS engine.
            anchored = SunglassesEngine._is_anchored(rx)
            entry["regex"].append({"source": src, "flags": fl, "anchored": anchored})
        if ok:
            slots.append((len(compiled), entry))
            compiled.append(entry)

    # Node syntax validation for every converted regex.
    flat, owners = [], []
    for idx, entry in enumerate(compiled):
        for ri, r in enumerate(entry["regex"]):
            flat.append({"id": entry["id"], "source": r["source"], "flags": r["flags"]})
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
              f"// Ported: {len(compiled)} ({kw_only} keyword-only) · Failed: {len(set(f['id'] for f in failed))}\n")
    os.makedirs(os.path.join(OUT_DIR, "src"), exist_ok=True)
    with open(os.path.join(OUT_DIR, "src", "patterns.js"), "w") as f:
        f.write(banner + "export const PATTERNS = " + json.dumps(compiled, separators=(",", ":")) + ";\n")
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
