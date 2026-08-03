import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("desktop release metadata preserves the npm CLI while pinning the Windows toolchain", () => {
  assert.equal(pkg.version, "0.5.0");
  assert.equal(pkg.main, "dist/index.js");
  assert.equal(pkg.bin.hive, "./bin/hive.mjs");
  assert.equal(pkg.engines.node, ">=22.12.0");
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
  assert.match(pkg.scripts["desktop:dist"], /electron-builder/);
});
