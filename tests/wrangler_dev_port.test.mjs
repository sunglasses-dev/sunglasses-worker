// A port that another process takes between the pick and the bind does not turn a run red: the start tries once more on new
// ports. Any other early exit still throws at once, and two clashes in a row still throw (one retry, not a loop).
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { startWranglerDev, freePort } from "./wrangler_dev_start.mjs";

const STAND_IN = fileURLToPath(new URL("./fixtures/stand_in_dev/server.mjs", import.meta.url));
const command = (env) => (port, inspector) => [process.execPath, [STAND_IN, "--port", String(port), "--inspector-port", String(inspector)], { env: { ...process.env, ...env } }];
const ready = async (port) => (await fetch(`http://127.0.0.1:${port}/`)).ok;
// A process that holds a port and never answers: a connection to it stays open until the test lets go of it.
const hold = () => new Promise((resolve) => {
  const sockets = new Set();
  const s = net.createServer((c) => { sockets.add(c); c.on("error", () => {}); }).listen(0, "127.0.0.1", () => {
    const close = s.close.bind(s);
    s.close = () => { for (const c of sockets) c.destroy(); close(); };
    resolve(s);
  });
});
const picks = (...ports) => { const list = [...ports]; const seen = []; const next = async () => { const p = list.length ? list.shift() : await freePort(); seen.push(p); return p; }; next.seen = seen; return next; };

test("a port that is taken before wrangler binds it: the start goes on with new ports and the server answers", async () => {
  const taken = await hold();
  const pickPort = picks(taken.address().port, await freePort());
  let started;
  try {
    started = await startWranglerDev({ command: command({}), ready, pickPort, timeoutMs: 20_000 });
    assert.equal(started.attempt, 2);
    assert.notEqual(started.port, taken.address().port);
    assert.ok(await ready(started.port));
  } finally { started?.stop(); taken.close(); }
});

test("a port that is free is used on the first attempt", async () => {
  const started = await startWranglerDev({ command: command({}), ready, timeoutMs: 20_000 });
  try { assert.equal(started.attempt, 1); assert.ok(await ready(started.port)); } finally { started.stop(); }
});

test("two address clashes in a row throw: one retry, not a loop", async () => {
  const taken = await hold();
  const port = taken.address().port;
  const pickPort = picks(port, await freePort(), port, await freePort());
  try {
    await assert.rejects(startWranglerDev({ command: command({}), ready, pickPort, timeoutMs: 20_000 }), /Address already in use/);
    assert.equal(pickPort.seen.length, 4);
  } finally { taken.close(); }
});

test("an exit that is not an address clash throws at once, with no second start", async () => {
  const pickPort = picks();
  await assert.rejects(startWranglerDev({ command: command({ STAND_IN_FAIL: "other" }), ready, pickPort, timeoutMs: 20_000 }), /a different failure/);
  assert.equal(pickPort.seen.length, 2);
});
