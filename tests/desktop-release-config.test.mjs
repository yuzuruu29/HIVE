import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stageDesktopApplication } from "../scripts/stage-desktop-app.mjs";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("desktop release metadata preserves the npm CLI while pinning the Windows toolchain", () => {
  assert.equal(pkg.version, "0.6.0");
  assert.equal(pkg.main, "dist/index.js");
  assert.equal(pkg.bin.hive, "./bin/hive.mjs");
  assert.equal(pkg.engines.node, ">=22.17.0");
  assert.equal(pkg.devDependencies.electron, "43.1.0");
  assert.equal(pkg.devDependencies["electron-builder"], "26.15.3");
  assert.equal(pkg.devDependencies["@playwright/test"], "1.61.1");
  assert.equal(pkg.build.appId, "com.hive.desktop");
  assert.equal(pkg.build.productName, "HIVE");
  assert.deepEqual(pkg.build.asarUnpack, ["dist/desktop/electron/worker.mjs"]);
  assert.deepEqual(pkg.build.win.target, [{ target: "nsis", arch: ["x64"] }, { target: "portable", arch: ["x64"] }]);
  assert.equal(pkg.build.nsis.oneClick, false);
  assert.equal(pkg.build.nsis.perMachine, false);
  assert.equal(pkg.build.publish, null);
});

test("desktop release scripts build both surfaces, smoke the package, and checksum artifacts", () => {
  for (const script of ["build:desktop", "desktop:dev", "desktop:e2e", "desktop:pack", "desktop:smoke", "desktop:dist", "desktop:checksum"]) {
    assert.equal(typeof pkg.scripts[script], "string", `${script} is missing`);
  }
  assert.match(pkg.scripts["desktop:e2e"], /playwright test/);
  assert.match(pkg.scripts["desktop:dist"], /package-desktop\.mjs/);
});

test("desktop release includes council prompts, references, and redistribution notices", () => {
  for (const required of [
    "skills/hive-mind-council/skills/hive-mind-council/SKILL.md",
    "skills/hive-mind-council/skills/hive-mind-council/agents/*.md",
    "skills/hive-mind-council/skills/hive-mind-council/references/*.md",
    "skills/hive-mind-council/LICENSE",
    "skills/hive-mind-council/README.md",
    "LICENSE",
    "NOTICE.md",
  ]) {
    assert.ok(pkg.build.files.includes(required), `Desktop release is missing ${required}`);
  }
});

test("prepackaged desktop staging contains council assets and notices without vendored development files", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hive-desktop-staging-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceRoot = path.join(directory, "source");
  const stagingRoot = path.join(directory, "staged app");
  const council = "skills/hive-mind-council";
  const skill = `${council}/skills/hive-mind-council`;
  const required = [
    "dist/desktop/electron/main.js", "dist/desktop/electron/worker.mjs", "dist-desktop/renderer/index.html",
    "LICENSE", "NOTICE.md", `${council}/LICENSE`, `${council}/README.md`, `${skill}/SKILL.md`,
    ...["Queen", "Scout", "Architect", "Forger", "Sentinel", "Scribe"].map((agent) => `${skill}/agents/${agent}.md`),
    ...["council-protocol", "handoff-schema", "orchestration-presets", "role-contracts", "runtime-capabilities", "safety-policy", "verification-policy"].map((reference) => `${skill}/references/${reference}.md`),
  ];
  const excluded = [
    `${council}/adapters/codex/AGENTS.md`, `${council}/.git/config`, `${council}/docs/private.md`,
    `${skill}/agents/.env`, `${skill}/agents/Queen.test.js`, `${skill}/references/private.txt`,
  ];
  const files = new Map([
    ["package.json", JSON.stringify({ name: "@uzzy-malolos/hive", main: "dist/index.js", version: "0.6.0" })],
    ...[...required, ...excluded].map((filename) => [filename, `fixture: ${filename}\n`]),
  ]);
  for (const [filename, content] of files) {
    const target = path.join(sourceRoot, filename);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  stageDesktopApplication({ sourceRoot, stagingRoot });

  assert.equal(JSON.parse(await readFile(path.join(stagingRoot, "package.json"), "utf8")).main, "dist/desktop/electron/main.js");
  for (const filename of required) {
    assert.equal(await readFile(path.join(stagingRoot, filename), "utf8"), files.get(filename), `Staging must preserve ${filename}`);
  }
  const staged = (await readdir(stagingRoot, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(stagingRoot, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
  assert.deepEqual(staged, ["package.json", ...required].sort());
});
