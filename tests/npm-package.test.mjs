import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const lock = JSON.parse(await readFile(new URL("package-lock.json", root), "utf8"));

test("npm identity and lockfile use the public scoped package without renaming the CLI", () => {
  assert.equal(manifest.name, "@uzzy-malolos/hive");
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.packages[""].name, manifest.name);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].version, manifest.version);
  assert.equal(manifest.license, "MIT");
  assert.equal(lock.packages[""].license, manifest.license);
  assert.equal(manifest.private, false);
  assert.deepEqual(manifest.publishConfig, {
    access: "public",
    registry: "https://registry.npmjs.org/",
  });
  assert.equal(manifest.bin.hive, "./bin/hive.mjs");
  assert.equal(manifest.main, "dist/index.js");
  assert.equal(manifest.types, "dist/index.d.ts");
});

test("packing builds the runtime rather than requiring consumer install hooks", async () => {
  assert.equal(manifest.scripts.prepack, "npm run build");
  assert.equal(manifest.scripts["test:package"], "node scripts/test-npm-package.mjs");
  for (const lifecycle of ["preinstall", "install", "postinstall", "prepare"]) {
    assert.equal(manifest.scripts[lifecycle], undefined, `${lifecycle} must not require consumer build tools`);
  }
  const launcher = await readFile(new URL("bin/hive.mjs", root), "utf8");
  assert.match(launcher, /^#!\/usr\/bin\/env node\r?\n/);
  assert.match(launcher, /\.\.\/dist\/index\.js/);
});

test("npm allowlist contains compiled code and built-in council assets, not development trees", () => {
  for (const required of [
    "bin/hive.mjs",
    "dist/**/*.js",
    "dist/**/*.d.ts",
    "skills/hive-mind-council/skills/hive-mind-council/SKILL.md",
    "skills/hive-mind-council/skills/hive-mind-council/agents/*.md",
    "skills/hive-mind-council/skills/hive-mind-council/references/*.md",
    "skills/hive-mind-council/LICENSE",
    "LICENSE",
    "NOTICE.md",
    "README.md",
    "docs/NPM_RELEASE.md",
  ]) {
    assert.ok(manifest.files.includes(required), `Missing npm allowlist entry: ${required}`);
  }
  assert.ok(manifest.files.every((entry) => !/^(?:\.|src(?:\/|$)|tests(?:\/|$)|scripts(?:\/|$)|desktop(?:\/|$)|web(?:\/|$)|node_modules(?:\/|$)|\*\*)/.test(entry)));
  assert.deepEqual(manifest.build.files, [
    "dist/**/*", "dist-desktop/renderer/**/*", "package.json",
    "skills/hive-mind-council/skills/hive-mind-council/SKILL.md",
    "skills/hive-mind-council/skills/hive-mind-council/agents/*.md",
    "skills/hive-mind-council/skills/hive-mind-council/references/*.md",
    "skills/hive-mind-council/LICENSE", "skills/hive-mind-council/README.md", "LICENSE", "NOTICE.md",
  ]);
  assert.ok(!Object.hasOwn(manifest.dependencies, "typescript"));
  assert.ok(!Object.hasOwn(manifest.dependencies, "electron"));
});

test("CI validates the npm artifact on Windows and Ubuntu without a publish step", async () => {
  const workflow = (await readFile(new URL(".github/workflows/ci.yml", root), "utf8")).replaceAll("\r\n", "\n");
  const job = workflow.match(/^  npm-package:\n([\s\S]*?)(?=^  [A-Za-z][\w-]*:\n|$(?![\s\S]))/m)?.[1];
  assert.ok(job, "npm package CI job is missing");
  assert.match(job, /os: \[ubuntu-latest, windows-latest\]/);
  assert.match(job, /node-version: '22\.17\.0'/);
  assert.match(job, /npm ci/);
  assert.match(job, /npm run test:package/);
  assert.doesNotMatch(workflow, /npm publish|NPM_TOKEN|NODE_AUTH_TOKEN/);
});
