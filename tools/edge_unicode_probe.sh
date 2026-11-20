#!/bin/bash
# edge_unicode_probe.sh - ask the Cloudflare edge which Unicode it reads, and compare with the pinned tables.
# Run at every wrangler bump and once a week. Prints the report; exit 0 = the edge differs from the tables only by
# code points the tables call unassigned (the worker does not depend on those) and its lower case and NFKC digests equal the pinned
# interpreter's on every block; exit 1 = a code point the tables hold that the edge does not, or a block whose lower case / NFKC digest differs
# (report.lower_nfkc.differ); exit 2 = no answer.
set -u
cd "$(dirname "$0")/edge_unicode_probe" || exit 2
PORT=${PORT:-8791}
WR=${WRANGLER_BIN:-../../node_modules/.bin/wrangler}
"$WR" dev --remote --port "$PORT" >/tmp/edge_probe_dev.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT
for _ in $(seq 1 60); do sleep 2; OUT=$(curl -sf "http://127.0.0.1:$PORT/" 2>/dev/null) && break; OUT=""; done
[ -n "${OUT:-}" ] || { echo "no answer from the edge probe (see /tmp/edge_probe_dev.log)"; exit 2; }
printf '%s\n' "$OUT"
printf '%s' "$OUT" | node -e '
const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
let bad = 0;
for (const [n, c] of Object.entries(r.classes)) {
  // a class the edge knows MORE of (a newer Unicode) is fine for L N Nd M XID: those code points are unassigned in the tables.
  // Any code point the TABLE has and the edge lacks, except in C and Cn (now assigned there), is a real difference.
  if (c.table_only > 0 && n !== "C" && n !== "Cn") bad++;
}
// lower case and NFKC: one differing block is a real difference (the edge answers an assigned character as another Unicode version does)
if (!r.lower_nfkc || r.lower_nfkc.differ.length > 0) bad++;
process.exit(bad ? 1 : 0);'
