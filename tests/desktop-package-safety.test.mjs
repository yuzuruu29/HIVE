import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import asar from "@electron/asar";
import { Data, NtExecutable, NtExecutableResource, Resource } from "resedit";
import { decorateDesktopExecutable, desktopPackageOptions, prepareDesktopPackageDirectories, writeDesktopAsar } from "../scripts/package-desktop.mjs";

const scratch = path.resolve(process.env.HIVE_PACKAGE_TEST_ROOT ?? "test-results/desktop-package-safety");
const manifest = path.resolve(process.env.HIVE_CLEANUP_MANIFEST ?? path.join(scratch, "cleanup-manifest.txt"));
await mkdir(scratch, { recursive: true });
await appendFile(manifest, `${scratch}\n${manifest}\n`);

async function fixture(t) {
  const directory = path.join(scratch, `case-${randomUUID()}`);
  await appendFile(manifest, `${directory}\n`);
  await mkdir(directory);
  t.after(async () => {
    assert.ok(path.relative(scratch, directory) && !path.relative(scratch, directory).startsWith(".."));
    await rm(directory, { recursive: true });
  });
  return directory;
}

test("desktop packaging accepts isolated build and output roots without changing installed tool paths", async (t) => {
  const directory = await fixture(t);
  const options = desktopPackageOptions([
    "--source-root", path.join(directory, "compiled source"),
    "--staging-dir", path.join(directory, "staged app"),
    "--output-dir", path.join(directory, "artifacts"),
    "--unpacked-dir", path.join(directory, "unpacked app"),
    "--manifest", path.join(directory, "cleanup-manifest.txt"),
  ], directory);
  assert.equal(options.sourceRoot, path.join(directory, "compiled source"));
  assert.equal(options.stagingDir, path.join(directory, "staged app"));
  assert.equal(options.outDir, path.join(directory, "artifacts"));
  assert.equal(options.unpackedDir, path.join(directory, "unpacked app"));
  assert.ok(options.electronDist.endsWith(path.join("node_modules", "electron", "dist")));
  assert.ok(!options.electronDist.startsWith(options.sourceRoot));
  prepareDesktopPackageDirectories(options);
  const owned = (await readFile(options.manifest, "utf8")).trim().split("\n");
  for (const target of [options.stagingDir, options.outDir, options.unpackedDir]) assert.ok(owned.includes(target));
});

test("desktop packaging refuses existing staging and output without deleting or creating anything", async (t) => {
  for (const existing of ["stagingDir", "outDir", "unpackedDir"]) {
    const directory = await fixture(t);
    const options = desktopPackageOptions([
      "--staging-dir", path.join(directory, "staging"),
      "--output-dir", path.join(directory, "output"),
      "--unpacked-dir", path.join(directory, "unpacked"),
      "--manifest", path.join(directory, "manifest.txt"),
    ], directory);
    await mkdir(options[existing], { recursive: true });
    await writeFile(path.join(options[existing], "keep.txt"), "user-owned content");
    assert.throws(() => prepareDesktopPackageDirectories(options), /already exists/);
    assert.equal(await readFile(path.join(options[existing], "keep.txt"), "utf8"), "user-owned content");
    await assert.rejects(readFile(options.manifest), { code: "ENOENT" });
  }
});

test("desktop packaging rejects malformed arguments and overlapping targets", () => {
  assert.throws(() => desktopPackageOptions(["--staging-dir"]), /requires a value/);
  assert.throws(() => desktopPackageOptions(["--unknown", "value"]), /Unknown/);
  assert.throws(() => desktopPackageOptions(["--output-dir", process.cwd()]), /overlap/);
  assert.throws(() => desktopPackageOptions(["--staging-dir", "dist-binaries"]), /overlap/);
});

test("manual desktop packaging embeds HIVE metadata and every configured icon size", async (t) => {
  const directory = await fixture(t);
  const executablePath = path.join(directory, "HIVE.exe");
  const sourceRoot = path.resolve(import.meta.dirname, "..");
  const metadata = JSON.parse(await readFile(path.join(sourceRoot, "package.json"), "utf8"));
  const icon = Data.IconFile.from(await readFile(path.join(sourceRoot, metadata.build.win.icon)));
  const executable = NtExecutable.createEmpty(false, false);
  const resources = NtExecutableResource.from(executable);
  const version = Resource.VersionInfo.createEmpty();
  version.lang = 1033;
  version.setStringValues({ lang: 1033, codepage: 1200 }, { ProductName: "Electron", FileDescription: "Electron" });
  version.setFileVersion("1.0.0.0");
  version.outputToResourceEntries(resources.entries);
  Resource.IconGroupEntry.replaceIconsForResource(resources.entries, 1, 1033, [icon.icons[0].data]);
  resources.outputResource(executable);
  await writeFile(executablePath, Buffer.from(executable.generate()));

  await decorateDesktopExecutable({ sourceRoot, executablePath });

  const decorated = NtExecutableResource.from(NtExecutable.from(await readFile(executablePath)));
  const actualVersion = Resource.VersionInfo.fromEntries(decorated.entries)[0];
  const strings = actualVersion.getStringValues({ lang: 1033, codepage: 1200 });
  assert.equal(strings.ProductName, metadata.build.productName);
  assert.equal(strings.FileDescription, metadata.build.productName);
  assert.equal(strings.LegalCopyright, metadata.build.copyright);
  assert.equal(strings.CompanyName, metadata.author);
  assert.equal(strings.FileVersion, metadata.version);
  assert.equal(strings.ProductVersion, `${metadata.version}.0`);
  assert.equal(strings.InternalName, "HIVE");
  assert.equal(strings.OriginalFilename, "HIVE.exe");
  const groups = Resource.IconGroupEntry.fromEntries(decorated.entries);
  assert.equal(groups.length, 1);
  const icons = groups[0].getIconItemsFromEntries(decorated.entries);
  assert.deepEqual(icons.map((item) => item.width || 256), [16, 24, 32, 48, 64, 128, 256]);
  assert.equal(icons.length, icon.icons.length);
  const bytes = (item) => Buffer.from(item.isRaw() ? item.bin : item.generate());
  for (let index = 0; index < icons.length; index++) {
    assert.deepEqual(bytes(icons[index]), bytes(icon.icons[index].data), `Embedded icon ${icons[index].width}px must match HIVE source`);
  }
});

test("desktop ASAR is fully flushed before an immediate synchronous packaging consumer", async (t) => {
  const directory = await fixture(t);
  const staged = path.join(directory, ".hidden-source", "staged");
  const worker = path.join("dist", "desktop", "electron", "worker.mjs");
  const main = path.join("dist", "desktop", "electron", "main.js");
  const mainContent = "// desktop main payload\n".repeat(150_000);
  const workerContent = "// production worker fixture\n";
  await mkdir(path.join(staged, path.dirname(main)), { recursive: true });
  await writeFile(path.join(staged, main), mainContent);
  await writeFile(path.join(staged, worker), workerContent);
  const archive = path.join(directory, "app.asar");

  const archiveStream = await writeDesktopAsar(staged, archive);

  // A synchronous installer process blocks all pending writes in its Node parent.
  assert.equal(archiveStream.writableFinished, true, "ASAR writer must finish before packaging starts");
  assert.ok(statSync(archive).size > Buffer.byteLength(mainContent), "ASAR payload must already be on disk");
  assert.equal(asar.extractFile(archive, main).toString(), mainContent);
  assert.equal(readFileSync(path.join(`${archive}.unpacked`, worker), "utf8"), workerContent);
  assert.equal(asar.statFile(archive, main).unpacked, undefined);
  assert.equal(asar.statFile(archive, worker).unpacked, true);
});
