import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * Walks upward from {@link cwd} looking for HIVE's repository root
 * (a directory whose package.json declares "@uzzy-malolos/hive" or legacy "hive").
 * Returns {@link cwd} if no root is found within 8 levels.
 */
export async function findRepoRoot(cwd: string): Promise<string> {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 8; i += 1) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf-8"));
      if (pkg && (pkg.name === "@uzzy-malolos/hive" || pkg.name === "hive")) return dir;
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return cwd;
}

/** Locates the built-in hive-mind-council skill (the directory holding agents/Queen.md). */
export async function locateSkillRoot(cwd: string): Promise<string | null> {
  const repoRoot = await findRepoRoot(cwd);
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const candidates = [
    path.join(repoRoot, "skills", "hive-mind-council", "skills", "hive-mind-council"),
    path.join(repoRoot, "skills", "hive-mind-council"),
    path.join(cwd, "skills", "hive-mind-council", "skills", "hive-mind-council"),
    path.join(cwd, "skills", "hive-mind-council"),
    // src/chat and dist/chat are both two levels below the installed package root.
    path.join(packageRoot, "skills", "hive-mind-council", "skills", "hive-mind-council"),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(path.join(candidate, "agents", "Queen.md"));
      return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}
