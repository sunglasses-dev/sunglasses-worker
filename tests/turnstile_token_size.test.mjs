// Lab finding C2, open survivor. The body ceiling bounds what the Worker admits to the
// parser, not what it forwards: a Turnstile token of several hundred KB is sent to
// siteverify as it is, one outbound POST per request, although Cloudflare tokens
// never exceed 2048 characters. Local only: fetch is stubbed.
//
// The survivor is pinned as it behaves today: the request is refused with 403 and the
// token is forwarded exactly once. The 403 is asserted without exception, so any other
// answer (a 500, a 200) fails this test. The forward count is the survivor: when a later
// change refuses an oversized token before the round trip, the count drops to 0 and the
// last assertion fails with a message to change the pin to the plain 0.
import { test } from "node:test";
import assert from "node:assert/strict";

const worker = (await import("../src/index.js")).default;

test("a Turnstile token longer than 2048 characters is still forwarded once to siteverify (open, pinned)", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response(JSON.stringify({ success: false }), { status: 200 }); };
  let res;
  try {
    res = await worker.fetch(new Request("https://sunglasses.dev/api/scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello", turnstile_token: "t".repeat(500_000) }),
    }), { TURNSTILE_SECRET: "set" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(res.status, 403);
  assert.equal(calls, 1, "this survivor is closed now (the token was not forwarded): pin calls to 0 and rename the test");
});
