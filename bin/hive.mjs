#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { runCoderCli } from "../dist/index.js";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

try {
  // Always resolve .env relative to the current working directory.
  const envPath = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf8");
    for (const line of envContent.split("\n")) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let value = match[2] || "";
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
        if (!(key in process.env)) {
          process.env[key] = value.trim();
        }
      }
    }
  }
} catch (e) {
  // Ignore errors reading .env
}

const result = await runCoderCli(process.argv.slice(2));

// "__TUI_STARTED__" is a sentinel: the TUI ran and exited cleanly.
// Do not print it to stdout.
if (result.output === "__TUI_STARTED__") {
  process.exitCode = result.exitCode;
} else {
  const stream = result.exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`${result.output}\n`);
  process.exitCode = result.exitCode;
}
