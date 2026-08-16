import path from "node:path";
import fs from "node:fs/promises";

/**
 * Walks upward from {@link cwd} looking for HIVE's repository root
 * (a directory whose package.json declares name === "hive").
 * Returns {@link cwd} if no root is found within 8 levels.
 */
export async function findRepoRoot(cwd: string): Promise<string> {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 8; i += 1) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf-8"));
      if (pkg && pkg.name === "hive") return dir;
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
  const candidates = [
    path.join(repoRoot, "skills", "hive-mind-council", "skills", "hive-mind-council"),
    path.join(repoRoot, "skills", "hive-mind-council"),
    path.join(cwd, "skills", "hive-mind-council", "skills", "hive-mind-council"),
    path.join(cwd, "skills", "hive-mind-council"),
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
