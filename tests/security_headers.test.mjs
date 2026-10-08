// Lab finding C1 on the Worker. The site's _headers file only reaches Pages
// responses, so the Worker has to set its own. Local only, nothing is contacted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import vm from "node:vm";

const worker = (await import("../src/index.js")).default;
const DEV = { TURNSTILE_DISABLED: "1" };
const get = (path, env = DEV) => worker.fetch(new Request("https://sunglasses.dev/api" + path), env);
const post = (path, body, env = DEV) => worker.fetch(new Request("https://sunglasses.dev/api" + path, {
  method: "POST", headers: { "content-type": "application/json" }, body }), env);

const page = await get("/");
const html = await page.clone().text();
const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

test("C1: the demo page carries a CSP that forbids framing and everything not listed", () => {
  const csp = page.headers.get("content-security-policy");
  assert.ok(csp, "HTML page has no Content-Security-Policy header");
  for (const part of ["default-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'", "connect-src 'self'"]) {
    assert.ok(csp.includes(part), `CSP is missing ${part}`);
  }
});

test("C1: the CSP lets the one inline script run by hash and never by unsafe-inline", () => {
  const csp = page.headers.get("content-security-policy") || "";
  const scriptSrc = (csp.split(";").map((s) => s.trim()).find((s) => s.startsWith("script-src")) || "");
  assert.ok(scriptSrc, "no script-src");
  assert.doesNotMatch(scriptSrc, /unsafe-inline|unsafe-eval|\*|data:|https?:|'self'|blob:/);
  assert.deepEqual(scriptSrc.split(/\s+/).slice(1).filter((t) => !t.startsWith("'sha256-")), []);
  assert.equal(inlineScripts.length, 1);
  const hash = createHash("sha256").update(inlineScripts[0]).digest("base64");
  assert.ok(scriptSrc.includes(`'sha256-${hash}'`), "script-src hash does not match the inline script");
});

test("C1: the page has no external script, frame or inline event handler the CSP would break", () => {
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<iframe/i);
  assert.doesNotMatch(html, /\son(click|load|error)=/i);
});

test("C1: the page answers with frame protection, nosniff and a referrer policy", () => {
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(page.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
});

test("C1: every server value the page writes into innerHTML is escaped", async () => {
  // Run the served script against a stub page and hostile response fields.
  const hostile = '<img src=x onerror=alert(1)>';
  const run = async (payload) => {
    const el = () => ({ value: "hello", dataset: {}, textContent: "", innerHTML: "", disabled: false, addEventListener() {}, click() {} });
    const els = { txt: el(), out: el(), go: el(), stat: el(), channel: el() };
    const sandbox = {
      document: { getElementById: (id) => els[id], querySelectorAll: () => [] },
      fetch: async () => ({ json: async () => payload }),
      JSON, String, Number, Array, Object,
    };
    vm.runInNewContext(inlineScripts[0], sandbox);
    await els.go.onclick();
    return els.out.innerHTML;
  };
  const finding = { id: hostile, category: hostile, severity: hostile, name: hostile, description: hostile, matched_text: hostile };
  const shapes = [
    { error: hostile },
    { decision: hostile, latency_ms: hostile, verdict_meaning: hostile, findings: [finding] },
    { decision: "block", latency_ms: hostile, verdict_meaning: hostile, findings: [finding] },
  ];
  for (const payload of shapes) {
    const rendered = await run(payload);
    const label = JSON.stringify(Object.keys(payload));
    assert.ok(rendered.length > 0);
    assert.doesNotMatch(rendered, /<img/i, label);
    assert.doesNotMatch(rendered, /Request failed/, `${label} went through the exception path`);
    assert.match(rendered, /&lt;img src=x onerror=alert\(1\)&gt;/, `${label} did not render the escaped marker`);
  }
});

test("C1: JSON answers carry nosniff, frame protection and the referrer policy", async () => {
  const answers = [
    await get("/about"),
    await get("/nope"),
    await post("/scan", JSON.stringify({ text: "hello" })),
    await post("/scan", "not json"),
    await post("/scan", JSON.stringify({ text: "hi", channel: "bad" })),
    await post("/scan", JSON.stringify({ text: "hi" }), {}),
    await post("/scan-github", JSON.stringify({ url: "https://example.com/x" })),
    await post("/scan-github", "not json"),
  ];
  for (const r of answers) {
    assert.equal(r.headers.get("x-content-type-options"), "nosniff", `status ${r.status}`);
    assert.equal(r.headers.get("x-frame-options"), "DENY", `status ${r.status}`);
    assert.equal(r.headers.get("referrer-policy"), "strict-origin-when-cross-origin", `status ${r.status}`);
  }
});

test("C1: the OPTIONS answer and the 500 answer carry them too", async () => {
  const opt = await worker.fetch(new Request("https://sunglasses.dev/api/scan", { method: "OPTIONS" }), DEV);
  for (const [name, value] of [["x-content-type-options", "nosniff"], ["x-frame-options", "DENY"], ["referrer-policy", "strict-origin-when-cross-origin"]]) {
    assert.equal(opt.headers.get(name), value, `OPTIONS ${name}`);
  }
  assert.equal(opt.headers.get("access-control-allow-origin"), "*");
  const real = globalThis.TextEncoder;
  globalThis.TextEncoder = class { encode() { throw new Error("boom"); } };
  let boom;
  try { boom = await post("/scan", JSON.stringify({ text: "hello" })); } finally { globalThis.TextEncoder = real; }
  assert.equal(boom.status, 500);
  for (const [name, value] of [["x-content-type-options", "nosniff"], ["x-frame-options", "DENY"], ["referrer-policy", "strict-origin-when-cross-origin"]]) {
    assert.equal(boom.headers.get(name), value, `500 ${name}`);
  }
  assert.equal(boom.headers.get("access-control-allow-origin"), "*");
});

test("C1: existing headers are unchanged", async () => {
  const r = await get("/about");
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.match(r.headers.get("content-type"), /^application\/json/);
  assert.match(page.headers.get("content-type"), /^text\/html; charset=utf-8/);
});
