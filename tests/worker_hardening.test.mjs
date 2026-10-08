// Lab findings G4, G9, G10 and G11 on the Worker. Local only: every upstream fetch is
// stubbed, nothing here touches GitHub, Cloudflare or the live site.
import { test } from "node:test";
import assert from "node:assert/strict";

const worker = (await import("../src/index.js")).default;
const JSON_HEADER = { "content-type": "application/json" };
const DEV = { TURNSTILE_DISABLED: "1" };
const CAP = 100_000;
const CHUNK = 65_536;

const post = (path, body, env = DEV, headers = JSON_HEADER) =>
  worker.fetch(new Request("https://sunglasses.dev/api" + path, { method: "POST", headers, body }), env);

async function withFetch(stub, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

// An upstream reply of `total` bytes with no content-length, like a chunked or
// compressed reply. The high-water mark is 0 so a pull means the worker asked.
function upstream(total, state, headers = { "content-type": "text/plain" }) {
  return new Response(new ReadableStream({
    pull(controller) {
      if (state.sent >= total) { controller.close(); return; }
      const n = Math.min(CHUNK, total - state.sent);
      controller.enqueue(new Uint8Array(n).fill(97));
      state.sent += n;
      state.pulled += n;
    },
    cancel() { state.cancelled += 1; },
  }, { highWaterMark: 0 }), { status: 200, headers });
}

// G4

test("G4: a single file with no content-length stops being read once the cap is passed", async () => {
  const state = { sent: 0, pulled: 0, cancelled: 0 };
  const res = await withFetch(async () => upstream(6_000_000, state), () =>
    post("/scan-github", JSON.stringify({ url: "https://github.com/o/r/blob/main/README.md" })));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.match(JSON.stringify(data), /exceeds 100KB/);
  assert.ok(state.pulled <= CAP + 2 * CHUNK, `pulled ${state.pulled} bytes for a ${CAP} byte cap`);
  assert.equal(state.cancelled, 1);
});

test("G4: in a repo scan every file stops at the cap and is cancelled, each with its own counters", async () => {
  const states = [];
  await withFetch(async () => { const st = { sent: 0, pulled: 0, cancelled: 0 }; states.push(st); return upstream(6_000_000, st); }, () =>
    post("/scan-github", JSON.stringify({ url: "https://github.com/o/r" })));
  assert.ok(states.length >= 1);
  for (const [i, st] of states.entries()) {
    assert.ok(st.pulled <= CAP + 2 * CHUNK, `file ${i} pulled ${st.pulled} bytes for a ${CAP} byte cap`);
    assert.equal(st.cancelled, 1, `file ${i} was not cancelled`);
  }
});

test("G4: a file under the cap is still read whole and scanned", async () => {
  const body = "# hello\nplain readme text\n";
  const res = await withFetch(async () => new Response(body, { status: 200 }), () =>
    post("/scan-github", JSON.stringify({ url: "https://github.com/o/r/blob/main/README.md" })));
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.files[0].bytes, body.length);
});

test("G4: a file exactly at the cap passes and one byte more is refused", async () => {
  const run = async (n) => (await (await withFetch(async () => new Response("a".repeat(n), { status: 200 }), () =>
    post("/scan-github", JSON.stringify({ url: "https://github.com/o/r/blob/main/README.md" })))).json());
  assert.ok((await run(CAP)).files[0].decision);
  assert.match(JSON.stringify(await run(CAP + 1)), /exceeds 100KB/);
});

test("G4: a declared length over the cap is refused without reading the body", async () => {
  const state = { sent: 0, pulled: 0, cancelled: 0 };
  await withFetch(async () => upstream(6_000_000, state, { "content-length": "6000000" }), () =>
    post("/scan-github", JSON.stringify({ url: "https://github.com/o/r/blob/main/README.md" })));
  assert.equal(state.pulled, 0);
});

// G9

test("G9: a non JSON reply from the verifier is answered, not thrown, and the scan is refused", async () => {
  let res;
  try {
    res = await withFetch(async () => new Response("<html>502</html>", { status: 502 }), () =>
      post("/scan", JSON.stringify({ text: "hi", turnstile_token: "t" }), { TURNSTILE_SECRET: "s" }));
  } catch (err) { assert.fail(`worker threw instead of answering: ${err}`); }
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /verification is unavailable/i);
});

test("G9: a verifier that cannot be reached is answered, not thrown", async () => {
  let res;
  try {
    res = await withFetch(async () => { throw new TypeError("network down"); }, () =>
      post("/scan-github", JSON.stringify({ url: "https://github.com/o/r", turnstile_token: "t" }), { TURNSTILE_SECRET: "s" }));
  } catch (err) { assert.fail(`worker threw instead of answering: ${err}`); }
  assert.equal(res.status, 503);
});

test("G9: a url that is not a string answers 400 on /scan-github", async () => {
  for (const url of [5, { a: 1 }, ["x"], ["https://github.com/o/r"], true, null]) {
    let res;
    try { res = await post("/scan-github", JSON.stringify({ url })); }
    catch (err) { assert.fail(`worker threw for url ${JSON.stringify(url)}: ${err}`); }
    assert.equal(res.status, 400);
  }
  const missing = await post("/scan-github", JSON.stringify({}));
  assert.equal(missing.status, 400);
});

test("G9: a failure inside a route is answered as JSON with no detail, not thrown", async () => {
  const real = globalThis.TextEncoder;
  globalThis.TextEncoder = class { encode() { throw new Error("secret internal detail"); } };
  let res;
  try { res = await post("/scan", JSON.stringify({ text: "hello" })); }
  catch (err) { assert.fail(`worker threw instead of answering: ${err}`); }
  finally { globalThis.TextEncoder = real; }
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.doesNotMatch(text, /secret internal detail/);
  assert.equal(JSON.parse(text).error, "Internal error.");
});

// G10

test("G10: without a secret and without the explicit local opt out, /scan refuses", async () => {
  const res = await post("/scan", JSON.stringify({ text: "hi" }), {});
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /not configured/i);
});

test("G10: without a secret and without the opt out, /scan-github refuses", async () => {
  const res = await post("/scan-github", JSON.stringify({ url: "https://github.com/o/r" }), {});
  assert.equal(res.status, 403);
});

test("G10: the explicit local opt out still allows a scan", async () => {
  const res = await post("/scan", JSON.stringify({ text: "hi" }), { TURNSTILE_DISABLED: "1" });
  assert.equal(res.status, 200);
});

test("G10: any other value of the opt out does not disable the check", async () => {
  for (const v of ["0", "true", "", "yes", 1]) {
    const res = await post("/scan", JSON.stringify({ text: "hi" }), { TURNSTILE_DISABLED: v });
    assert.equal(res.status, 403, `value ${JSON.stringify(v)}`);
  }
});

test("G10: with the secret set the token is still required and a good token passes", async () => {
  const noToken = await post("/scan", JSON.stringify({ text: "hi" }), { TURNSTILE_SECRET: "s" });
  assert.equal(noToken.status, 403);
  const ok = await withFetch(async () => new Response(JSON.stringify({ success: true }), { status: 200 }), () =>
    post("/scan", JSON.stringify({ text: "hi", turnstile_token: "t" }), { TURNSTILE_SECRET: "s" }));
  assert.equal(ok.status, 200);
  const bad = await withFetch(async () => new Response(JSON.stringify({ success: false }), { status: 200 }), () =>
    post("/scan", JSON.stringify({ text: "hi", turnstile_token: "t" }), { TURNSTILE_SECRET: "s" }));
  assert.equal(bad.status, 403);
});

test("G10: the opt out does not beat a configured secret", async () => {
  const res = await post("/scan", JSON.stringify({ text: "hi" }), { TURNSTILE_SECRET: "s", TURNSTILE_DISABLED: "1" });
  assert.equal(res.status, 403);
});

// G11

test("G11: a long channel value is not echoed beyond a short prefix", async () => {
  const res = await post("/scan", JSON.stringify({ text: "hi", channel: "x".repeat(40) }));
  assert.equal(res.status, 400);
  const error = (await res.json()).error;
  assert.ok(!error.includes("x".repeat(33)), "echoed more than 32 characters");
});

test("G11: a long channel value is refused with a short body", async () => {
  const res = await post("/scan", JSON.stringify({ text: "hi", channel: "x".repeat(300_000) }));
  assert.equal(res.status, 400);
  assert.ok((await res.text()).length < 2000);
});

test("G11: a channel that is not a string is refused without being echoed whole", async () => {
  for (const channel of [{ a: "x".repeat(5000) }, ["y".repeat(5000)], 5, true]) {
    const res = await post("/scan", JSON.stringify({ text: "hi", channel }));
    assert.equal(res.status, 400);
    assert.ok((await res.text()).length < 2000);
  }
});

test("G11: a short unknown channel is still named and the valid list is still given", async () => {
  const res = await post("/scan", JSON.stringify({ text: "hi", channel: "nope" }));
  assert.equal(res.status, 400);
  const error = (await res.json()).error;
  assert.match(error, /Unknown channel "nope"/);
  assert.match(error, /Valid channels: /);
});

test("G11: the valid channels, the default and an empty channel are unchanged", async () => {
  for (const channel of [undefined, null, "", "message", "file", "tool_output"]) {
    const res = await post("/scan", JSON.stringify({ text: "hello there", channel }));
    assert.equal(res.status, 200, `channel ${JSON.stringify(channel)}`);
  }
});

// Turnstile siteverify reply cap

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const VERIFY_CAP = 16_384;
const SECRET_ENV = { TURNSTILE_SECRET: "s" };
const ROUTES = [
  ["/scan", { text: "hello", turnstile_token: "t" }],
  ["/scan-github", { url: "https://github.com/o/r/blob/main/README.md", turnstile_token: "t" }],
];

for (const [path, payload] of ROUTES) {
  test(`verifier cap: ${path} answers 503 and stops reading a siteverify reply with no content-length`, async () => {
    const state = { sent: 0, pulled: 0, cancelled: 0 };
    const res = await withFetch(async (u) => String(u) === VERIFY_URL ? upstream(6_000_000, state, { "content-type": "application/json" }) : new Response("x"), () =>
      post(path, JSON.stringify(payload), SECRET_ENV));
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /unavailable/i);
    assert.ok(state.pulled <= VERIFY_CAP + 2 * CHUNK, `pulled ${state.pulled} bytes for a ${VERIFY_CAP} byte cap`);
    assert.equal(state.cancelled, 1);
  });

  test(`verifier cap: ${path} answers 503 when siteverify lies about its length`, async () => {
    const state = { sent: 0, pulled: 0, cancelled: 0 };
    const res = await withFetch(async (u) => String(u) === VERIFY_URL ? upstream(6_000_000, state, { "content-type": "application/json", "content-length": "20" }) : new Response("x"), () =>
      post(path, JSON.stringify(payload), SECRET_ENV));
    assert.equal(res.status, 503);
    assert.ok(state.pulled <= VERIFY_CAP + 2 * CHUNK, `pulled ${state.pulled} bytes for a ${VERIFY_CAP} byte cap`);
    assert.equal(state.cancelled, 1);
  });

  test(`verifier cap: ${path} answers 503 without reading a siteverify reply that declares a huge length`, async () => {
    const state = { sent: 0, pulled: 0, cancelled: 0 };
    const res = await withFetch(async (u) => String(u) === VERIFY_URL ? upstream(6_000_000, state, { "content-type": "application/json", "content-length": "6000000" }) : new Response("x"), () =>
      post(path, JSON.stringify(payload), SECRET_ENV));
    assert.equal(res.status, 503);
    assert.equal(state.pulled, 0);
  });

  test(`verifier cap: ${path} still accepts a normal siteverify success`, async () => {
    const res = await withFetch(async (u) => String(u) === VERIFY_URL
      ? new Response(JSON.stringify({ success: true }), { status: 200, headers: { "content-type": "application/json" } })
      : new Response("# readme\n", { status: 200 }), () =>
      post(path, JSON.stringify(payload), SECRET_ENV));
    assert.equal(res.status, 200);
  });
}

test("verifier cap: a siteverify reply that is not JSON answers 503", async () => {
  const res = await withFetch(async () => new Response("<html>no</html>", { status: 200 }), () =>
    post("/scan", JSON.stringify({ text: "hello", turnstile_token: "t" }), SECRET_ENV));
  assert.equal(res.status, 503);
});
