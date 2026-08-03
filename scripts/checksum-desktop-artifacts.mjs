import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function writeDesktopChecksums({ directory, version }) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) throw new Error("A valid package version is required.");
  const expected = [`HIVE-${version}-x64-portable.exe`, `HIVE-${version}-x64-setup.exe`].sort();
  const names = (await readdir(directory)).filter((name) => name.toLowerCase().endsWith(".exe")).sort();
  const missing = expected.filter((name) => !names.includes(name));
  const unexpected = names.filter((name) => !expected.includes(name));
  if (missing.length) throw new Error(`Missing required Windows artifact(s): ${missing.join(", ")}.`);
  if (unexpected.length) throw new Error(`Unexpected Windows .exe artifact(s): ${unexpected.join(", ")}.`);
  const lines = [];
  for (const name of expected) {
    const file = path.join(directory, name);
    const digest = createHash("sha256").update(await readFile(file)).digest("hex");
    const size = (await stat(file)).size;
    lines.push(`${digest} *${name}`);
    console.log(`${name}\t${size}\t${digest}`);
  }
  await writeFile(path.join(directory, "SHA256SUMS.txt"), `${lines.join("\n")}\n`, "utf8");
  return { names: expected, lines };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
  await writeDesktopChecksums({ directory: path.resolve("release"), version: packageJson.version });
}
