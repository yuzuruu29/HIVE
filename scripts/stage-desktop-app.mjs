import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export function stageDesktopApplication({ sourceRoot, stagingRoot }) {
  mkdirSync(stagingRoot, { recursive: true });
  const pkg = JSON.parse(readFileSync(path.join(sourceRoot, "package.json"), "utf8"));
  pkg.main = "dist/desktop/electron/main.js";
  writeFileSync(path.join(stagingRoot, "package.json"), JSON.stringify(pkg, null, 2), "utf8");
  cpSync(path.join(sourceRoot, "dist"), path.join(stagingRoot, "dist"), { recursive: true });
  cpSync(path.join(sourceRoot, "dist-desktop", "renderer"), path.join(stagingRoot, "dist-desktop", "renderer"), { recursive: true });

  const council = path.join("skills", "hive-mind-council");
  const skill = path.join(council, "skills", "hive-mind-council");
  const assets = ["LICENSE", "NOTICE.md", path.join(council, "LICENSE"), path.join(council, "README.md"), path.join(skill, "SKILL.md")];
  for (const folder of ["agents", "references"]) {
    for (const entry of readdirSync(path.join(sourceRoot, skill, folder), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) assets.push(path.join(skill, folder, entry.name));
    }
  }
  for (const asset of assets) {
    const destination = path.join(stagingRoot, asset);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(sourceRoot, asset), destination);
  }
}
