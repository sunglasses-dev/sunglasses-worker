// The rate-limit answer only states what this Worker does. Statements about
// the pip scanner's rate behaviour cannot be checked from this repo, so they
// are not made here. Local only: nothing here touches the live site.
import { test } from "node:test";
import assert from "node:assert/strict";

const worker = (await import("../src/index.js")).default;
const ROUTES = ["https://sunglasses.dev/api/scan", "https://sunglasses.dev/api/scan-github"];
const env = { RATE_LIMITER: { limit: async () => ({ success: false }) } };

for (const url of ROUTES) {
  test(`${url}: the 429 answer states the demo limit and makes no claim about pip rate limiting`, async () => {
    const res = await worker.fetch(new Request(url, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }), env);
    assert.equal(res.status, 429);
    const { error } = await res.json();
    assert.match(error, /^Rate limit hit\. The demo allows 30 scans per minute\./);
    assert.doesNotMatch(error, /no rate limit/i);
    assert.match(error, /pip install sunglasses/);
  });
}
