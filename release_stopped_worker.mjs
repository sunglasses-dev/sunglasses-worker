// Reads a JSON list of [text, channel] pairs on argv[2] and writes the Worker's decision for each, as a JSON list.
import fs from "node:fs";
import { scan } from "./src/engine.js";

const rows = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
fs.writeFileSync(process.argv[3], JSON.stringify(rows.map(([text, channel]) => scan(text, channel).decision)));
