// Stands in for `wrangler dev` in a test of the start: binds --port and answers 200 on every request.
// STAND_IN_FAIL=other makes it exit at once with a message that is not an address clash.
import http from "node:http";
const at = process.argv.indexOf("--port");
const port = Number(process.argv[at + 1]);
if (process.env.STAND_IN_FAIL === "other") { console.error("a different failure"); process.exit(1); }
const server = http.createServer((req, res) => { res.statusCode = 200; res.end("{}"); });
server.on("error", (e) => { console.error(`Address already in use (127.0.0.1:${port}) ${e.code}`); process.exit(1); });
server.listen(port, "127.0.0.1");
