// Lab finding C2. Both POST routes read the
// body under a ceiling before anything is parsed, and only a plain JSON object
// reaches the route code. Local only: nothing here touches the live site.
import { test } from "node:test";
import assert from "node:assert/strict";

const worker = (await import("../src/index.js")).default;
const TEXT_ERROR = "Scan text is limited to 100000 UTF-8 bytes.";
const SCAN = "https://sunglasses.dev/api/scan";
const GITHUB = "https://sunglasses.dev/api/scan-github";
const LIMIT = 6 * 100_000 + 16_384; // MAX_BODY_BYTES in src/index.js
const CHUNK = 65_536;
// The most a worker that cancels at the first chunk over the ceiling can have pulled.
const FIRST_CROSSING = Math.ceil((LIMIT + 1) / CHUNK) * CHUNK;
const BODY_ERROR = /^The whole JSON request is limited to 616384 bytes\.$/;
const JSON_HEADER = { "content-type": "application/json" };

const post = (url, body, headers = JSON_HEADER, env = {}) =>
  worker.fetch(new Request(url, { method: "POST", headers, body, duplex: "half" }), env);

// A body source that records how many bytes the worker pulled from it. The
// high-water mark is 0 so the stream never pre-fills on its own: a pull means
// the worker asked for bytes.
function countingStream(total, chunk = CHUNK) {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream({
    pull(controller) {
      if (state.pulled >= total) { controller.close(); return; }
      const n = Math.min(chunk, total - state.pulled);
      controller.enqueue(new Uint8Array(n).fill(0x78));
      state.pulled += n;
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, state };
}

// A JSON object whose serialised form is exactly `bytes` long.
function paddedBody(bytes) {
  const head = '{"text":"hi","pad":"';
  const tail = '"}';
  return head + "x".repeat(bytes - head.length - tail.length) + tail;
}

for (const [name, url] of [["/scan", SCAN], ["/scan-github", GITHUB]]) {
  test(`${name}: a declared oversized body is refused before any byte is read`, async () => {
    const { stream, state } = countingStream(3_000_000);
    const res = await post(url, stream, { ...JSON_HEADER, "content-length": "3000000" });
    assert.equal(res.status, 413);
    assert.match((await res.json()).error, BODY_ERROR);
    assert.equal(state.pulled, 0, `worker pulled ${state.pulled} bytes of a body it had already refused`);
  });

  test(`${name}: an undeclared (chunked) oversized body is dropped once the ceiling is passed`, async () => {
    const { stream, state } = countingStream(3_000_000);
    const res = await post(url, stream);
    assert.equal(res.status, 413);
    assert.ok(state.pulled <= FIRST_CROSSING, `worker pulled ${state.pulled} bytes for a ${LIMIT}-byte ceiling`);
    assert.equal(state.cancelled, true, "the body stream was not cancelled");
  });

  test(`${name}: a content-length that lies low does not get an oversized body past the ceiling`, async () => {
    const { stream, state } = countingStream(3_000_000);
    const res = await post(url, stream, { ...JSON_HEADER, "content-length": "10" });
    assert.equal(res.status, 413);
    assert.ok(state.pulled <= FIRST_CROSSING, `worker pulled ${state.pulled} bytes`);
  });

  test(`${name}: non-object JSON and malformed bodies answer 400 with the body message`, async () => {
    const expected = name === "/scan" ? 'Body must be JSON: {"text"' : 'Body must be JSON: {"url"';
    for (const body of ["null", "[]", "5", '"x"', "true", "", "{", "﻿null", "[".repeat(300_000) + "]".repeat(300_000)]) {
      let res;
      try { res = await post(url, body); } catch (err) { assert.fail(`${JSON.stringify(body.slice(0, 20))}: worker threw: ${err}`); }
      assert.equal(res.status, 400, `${JSON.stringify(body.slice(0, 20))} -> ${res.status}`);
      const { error } = await res.json();
      assert.ok(error.startsWith(expected), `${JSON.stringify(body.slice(0, 20))} -> ${error}`);
    }
  });

  test(`${name}: an upload that breaks off mid-body answers 400, as request.json() did`, async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"text":"hel'));
        controller.error(new Error("client went away"));
      },
    });
    let res;
    try { res = await post(url, stream); } catch (err) { assert.fail(`worker threw instead of answering: ${err}`); }
    assert.equal(res.status, 400);
  });

  test(`${name}: a POST with no body answers 400`, async () => {
    const res = await worker.fetch(new Request(url, { method: "POST" }), {});
    assert.equal(res.status, 400);
  });

  test(`${name}: the rate limiter still answers before the body is read`, async () => {
    const { stream, state } = countingStream(1_000_000);
    const env = { RATE_LIMITER: { limit: async () => ({ success: false }) } };
    const res = await post(url, stream, { ...JSON_HEADER, "content-length": "1000000" }, env);
    assert.equal(res.status, 429);
    assert.equal(state.pulled, 0);
  });

  test(`${name}: a length header that is not a number does not skip the count`, async () => {
    // "1e999" reads as Infinity, so it is refused from the header with nothing pulled;
    // every other value is not a usable length and falls through to the byte count.
    for (const value of ["abc", "10, 20", "", "-5", "1e999"]) {
      const { stream, state } = countingStream(3_000_000);
      const res = await post(url, stream, { ...JSON_HEADER, "content-length": value });
      assert.equal(res.status, 413, `content-length ${JSON.stringify(value)}`);
      assert.ok(state.pulled <= FIRST_CROSSING, `content-length ${JSON.stringify(value)} pulled ${state.pulled}`);
      if (value !== "1e999") assert.equal(state.cancelled, true, `content-length ${JSON.stringify(value)}`);
    }
  });

  test(`${name}: a body with its own __proto__ key reaches the route as plain data`, async () => {
    const res = await post(url, '{"__proto__":{"text":"x","url":"https://github.com/o/r"},"channel":"message"}');
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, name === "/scan" ? /^Field "text"/ : /./);
    assert.equal(({}).text, undefined);
    assert.equal(({}).url, undefined);
  });

  test(`${name}: Turnstile still refuses a capped body that carries no token`, async () => {
    const res = await post(url, JSON.stringify({ text: "hello", url: "https://github.com/o/r" }), JSON_HEADER, { TURNSTILE_SECRET: "set" });
    assert.equal(res.status, 403);
  });
}

test("/scan: a body exactly at the ceiling is read, one byte more is refused", async () => {
  const at = await post(SCAN, paddedBody(LIMIT));
  assert.equal(at.status, 200, "a body at the ceiling must still be scanned");
  const over = await post(SCAN, paddedBody(LIMIT + 1));
  assert.equal(over.status, 413);
});

test("/scan: a 100 KB text made only of escaped control characters still fits the ceiling", async () => {
  const body = JSON.stringify({ text: "\u0001".repeat(100_000), channel: "message", turnstile_token: "t".repeat(2048) });
  assert.ok(new TextEncoder().encode(body).length > 600_000, "the probe must really be the 6x case");
  const res = await post(SCAN, body);
  assert.equal(res.status, 200);
});

test("/scan: the text cap is unchanged: 100,000 bytes pass, 100,001 are refused with the cap sentence", async () => {
  const ok = await post(SCAN, JSON.stringify({ text: "a".repeat(100_000), turnstile_token: "t".repeat(2048) }));
  assert.equal(ok.status, 200);
  const over = await post(SCAN, JSON.stringify({ text: "a".repeat(100_001) }));
  assert.equal(over.status, 413);
  assert.equal((await over.json()).error, TEXT_ERROR);
});

test("/scan: a BOM and invalid UTF-8 inside a string are decoded as request.json() did (200)", async () => {
  const bom = await post(SCAN, "﻿" + JSON.stringify({ text: "hello there" }));
  assert.equal(bom.status, 200);
  const bad = await post(SCAN, new Uint8Array([0x7b, 0x22, 0x74, 0x65, 0x78, 0x74, 0x22, 0x3a, 0x22, 0xff, 0x68, 0x69, 0x22, 0x7d]));
  assert.equal(bad.status, 200);
});

test("/scan: an object without a text field keeps its own 400", async () => {
  const res = await post(SCAN, JSON.stringify({ channel: "message", extra: 1 }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /^Field "text"/);
});

test("/scan-github: a well-formed small body still reaches the URL check", async () => {
  const res = await post(GITHUB, JSON.stringify({ url: "not a github url" }));
  assert.equal(res.status, 400);
  assert.doesNotMatch((await res.json()).error, /^Body must be JSON/);
});

// Behavior changes this PR makes on purpose, pinned so they stay deliberate.

test("/scan: a small text inside an oversized envelope is now refused, which was accepted before", async () => {
  const text = "hi";
  const bodies = {
    leading_whitespace: " ".repeat(LIMIT) + JSON.stringify({ text }),
    ignored_field: JSON.stringify({ text, extra: "x".repeat(LIMIT) }),
    repeated_key: '{"text":"' + "y".repeat(LIMIT) + '","text":"hi"}',
  };
  for (const [name, body] of Object.entries(bodies)) {
    const res = await post(SCAN, body);
    assert.equal(res.status, 413, name);
    assert.match((await res.json()).error, BODY_ERROR, name);
  }
});

test("/scan: the envelope refusal and the text refusal name different limits", async () => {
  const envelope = await (await post(SCAN, paddedBody(LIMIT + 1))).json();
  const text = await (await post(SCAN, JSON.stringify({ text: "a".repeat(100_001) }))).json();
  assert.match(envelope.error, /616384 bytes/);
  assert.doesNotMatch(envelope.error, /100KB/);
  assert.equal(text.error, TEXT_ERROR);
});

test("both routes: with a secret set and no token, a non-object body now answers 400 before Turnstile (it was 403)", async () => {
  for (const url of [SCAN, GITHUB]) {
    for (const body of ["null", "[]", "5", '"x"']) {
      const res = await post(url, body, JSON_HEADER, { TURNSTILE_SECRET: "set" });
      assert.equal(res.status, 400, `${url} ${body}`);
    }
  }
});

test("/scan-github: a repository scan that succeeds still answers 200 through the body reader", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response("# readme\nplain text\n", { status: 200, headers: { "content-length": "20" } });
  try {
    const res = await post(GITHUB, JSON.stringify({ url: "https://github.com/o/r/blob/main/README.md" }));
    assert.equal(res.status, 200);
    assert.ok((await res.json()).files.length >= 1);
  } finally {
    globalThis.fetch = real;
  }
});
