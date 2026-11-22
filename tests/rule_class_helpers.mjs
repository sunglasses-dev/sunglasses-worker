import { PATTERNS } from "../src/patterns.js";
import { MECHANISMS } from "../src/mechanisms.js";

// Every text of the rules' sources that holds a regex, with the flags it compiles with.
export function ruleSources() {
  const out = [];
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== "object") return;
    const flags = typeof o.flags === "string" ? o.flags : null;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "string" && v.includes("\\p{")) out.push({ source: v, flags: flags ?? "iu", key: k });
      else walk(v);
    }
  };
  walk(PATTERNS);
  walk(MECHANISMS);
  return out;
}
export const classEnd = (src, from) => {
  let i = from + 1;
  if (src[i] === "^") i++;
  for (; i < src.length; i++) {
    if (src[i] === "\\") i++;
    else if (src[i] === "]") return i;
  }
  return -1;
};
// Each class of a source that holds the property pair, with whether it folds case there ((?i:..) and (?-i:..) groups
// are followed).
export function classesOf(src, flags) {
  const out = [];
  const stack = [flags.includes("i")];
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "[") {
      const end = classEnd(src, i);
      const cls = src.slice(i, end + 1);
      if (cls.includes("\\p{")) out.push({ cls, fold: stack[stack.length - 1] });
      i = end + 1;
      continue;
    }
    if (c === "(") {
      let fold = stack[stack.length - 1];
      const m = /^\(\?([ims]*)(?:-([ims]*))?:/.exec(src.slice(i, i + 12));
      if (m) { if (m[1].includes("i")) fold = true; if (m[2]?.includes("i")) fold = false; }
      stack.push(fold);
    } else if (c === ")" && stack.length > 1) stack.pop();
    i++;
  }
  return out;
}

export const ALL = (() => {
  const parts = [];
  for (let c = 0; c <= 0x10ffff; c += 8192) {
    const cps = [];
    for (let d = c; d < c + 8192 && d <= 0x10ffff; d++) if (d < 0xd800 || d > 0xdfff) cps.push(d);
    parts.push(String.fromCodePoint(...cps));
  }
  return parts.join("");
})();
// One regex source against its explicit form on every scalar: what each leaves in the text must be the same text.
export const equalOnEveryScalar = (corrected, explicit, flags) =>
  ALL.replace(new RegExp(corrected, "g" + flags.replace(/[gy]/g, "")), "") === ALL.replace(new RegExp(explicit, "g" + flags.replace(/[gy]/g, "")), "");
