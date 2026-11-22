// Starts a `wrangler dev` for a test on a port the system hands out. A port that was free when it was picked can be taken
// by another process before wrangler binds it; wrangler then exits with "Address already in use" before it answers anything.
// That says nothing about the code under test, so the start is tried once more on two new ports. Any other early exit, and a
// second address clash, throw.
import { spawn } from "node:child_process";
import net from "node:net";

export const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const ADDRESS_IN_USE = /address already in use|EADDRINUSE/i;

// command(port, inspector) -> [executable, args, options]; ready(port) -> true once the server answers.
export async function startWranglerDev({ command, ready, pickPort = freePort, attempts = 2, timeoutMs = 120_000 }) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const port = await pickPort();
    const inspector = await pickPort();
    const [exe, args, options] = command(port, inspector);
    const child = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let log = "";
    child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
    const stop = () => child.kill("SIGTERM");
    const deadline = Date.now() + timeoutMs;
    let up = false;
    while (Date.now() < deadline && !up) {
      if (child.exitCode !== null) break;
      try { up = await Promise.race([ready(port), new Promise((_, no) => setTimeout(() => no(new Error("no answer")), 2000).unref())]); } catch { /* still booting, or a port someone else holds that never answers */ }
      if (!up) await new Promise((r) => setTimeout(r, 200));
    }
    if (up) return { child, port, log: () => log, stop, attempt };
    if (child.exitCode !== null) {
      last = new Error("wrangler dev exited early:\n" + log.slice(-800));
      if (attempt < attempts && ADDRESS_IN_USE.test(log)) continue;
      throw last;
    }
    stop();
    throw new Error("wrangler dev did not come up:\n" + log.slice(-800));
  }
  throw last;
}
