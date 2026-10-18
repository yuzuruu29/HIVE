import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import asar from "@electron/asar";
import { stageDesktopApplication } from "./stage-desktop-app.mjs";

const require = createRequire(import.meta.url);
const { AppInfo } = require("app-builder-lib/out/appInfo.js");
const { editWindowsResources } = require("app-builder-lib/out/util/resEdit.js");

export function desktopPackageOptions(args = [], cwd = process.cwd()) {
  const values = {};
  const names = new Set(["--source-root", "--staging-dir", "--unpacked-dir", "--output-dir", "--manifest"]);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!names.has(name)) throw new Error(`Unknown packaging argument: ${name}`);
    if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} requires a value.`);
    if (values[name]) throw new Error(`Duplicate packaging argument: ${name}`);
    values[name] = path.resolve(cwd, args[index + 1]);
  }
  const sourceRoot = values["--source-root"] ?? path.resolve(cwd);
  const outDir = values["--output-dir"] ?? path.join(sourceRoot, "dist-binaries");
  const stagingDir = values["--staging-dir"] ?? path.join(sourceRoot, "build", "staging-app");
  const unpackedDir = values["--unpacked-dir"] ?? path.join(outDir, "win-unpacked");
  if ([outDir, stagingDir, unpackedDir].some((target) => contains(target, sourceRoot))
    || contains(stagingDir, outDir) || contains(outDir, stagingDir)
    || contains(unpackedDir, stagingDir) || contains(stagingDir, unpackedDir)
    || contains(unpackedDir, outDir)) {
    throw new Error("Packaging paths overlap source files or each other.");
  }
  return {
    sourceRoot, outDir, stagingDir, unpackedDir,
    manifest: values["--manifest"] ?? path.join(outDir, "cleanup-manifest.txt"),
    electronDist: path.join(path.dirname(require.resolve("electron/package.json")), "dist"),
    builderCli: require.resolve("electron-builder/cli.js"),
  };
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function prepareDesktopPackageDirectories(options) {
  const targets = [options.outDir, options.stagingDir, options.unpackedDir];
  // Existing artifacts may belong to the user or another running packaging task.
  for (const target of targets) {
    if (existsSync(target)) throw new Error(`Packaging path already exists; choose a new isolated path: ${target}`);
  }
  const manifestParent = path.dirname(options.manifest);
  if (manifestParent !== options.outDir && !existsSync(manifestParent)) {
    throw new Error(`Packaging manifest parent must already exist: ${manifestParent}`);
  }
  mkdirSync(options.outDir);
  appendFileSync(options.manifest, `${[...targets, options.manifest].join("\n")}\n`, "utf8");
  mkdirSync(options.stagingDir);
  mkdirSync(options.unpackedDir);
}

export async function writeDesktopAsar(stagingDir, destination) {
  // ASAR matches the absolute source name with matchBase. A globstar skips
  // hidden ancestors such as .codex worktrees; basename matching does not.
  const output = await asar.createPackageWithOptions(stagingDir, destination, { unpack: "worker.mjs" });
  // The pinned ASAR API resolves with its stream before that stream finishes.
  await finished(output);
  return output;
}

export async function decorateDesktopExecutable({ sourceRoot, executablePath }) {
  const metadata = JSON.parse(readFileSync(path.join(sourceRoot, "package.json"), "utf8"));
  const config = metadata.build;
  const author = typeof metadata.author === "string" ? { name: metadata.author } : metadata.author;
  const appInfo = new AppInfo({ metadata: { ...metadata, author }, config }, undefined, config.win);
  const versionStrings = {
    FileDescription: appInfo.productName,
    ProductName: appInfo.productName,
    LegalCopyright: appInfo.copyright,
    InternalName: path.basename(executablePath, ".exe"),
    OriginalFilename: path.basename(executablePath),
    ...(appInfo.companyName ? { CompanyName: appInfo.companyName } : {}),
  };
  // --prepackaged skips electron-builder's executable resource editing.
  await editWindowsResources({
    file: executablePath, versionStrings,
    fileVersion: appInfo.shortVersion || appInfo.buildVersion,
    productVersion: appInfo.shortVersionWindows || appInfo.getVersionInWeirdWindowsForm(),
    iconPath: path.resolve(sourceRoot, config.win.icon),
    requestedExecutionLevel: "asInvoker",
  });
}

export async function packageDesktop(options) {
  prepareDesktopPackageDirectories(options);
  const { sourceRoot, stagingDir, unpackedDir, outDir, electronDist, builderCli } = options;
  const resourcesDir = path.join(unpackedDir, "resources");

  console.log("==> 1. Assembling staging app...");
  stageDesktopApplication({ sourceRoot, stagingRoot: stagingDir });

  console.log("==> 2. Populating win-unpacked base from Electron...");
  cpSync(electronDist, unpackedDir, { recursive: true });
  const defaultAppAsar = path.join(resourcesDir, "default_app.asar");
  if (existsSync(defaultAppAsar)) rmSync(defaultAppAsar);
  const defaultExe = path.join(unpackedDir, "electron.exe");
  const executablePath = path.join(unpackedDir, "HIVE.exe");
  cpSync(defaultExe, executablePath);
  rmSync(defaultExe);
  await decorateDesktopExecutable({ sourceRoot, executablePath });

  console.log("==> 3. Creating app.asar with unpacked worker...");
  await writeDesktopAsar(stagingDir, path.join(resourcesDir, "app.asar"));

  console.log("==> 4. Packaging NSIS installer & Portable executable with electron-builder...");
  execFileSync(process.execPath, [
    builderCli, "--win", "nsis", "portable", "--x64", "--prepackaged", unpackedDir,
    `--config.directories.output=${outDir}`, "--publish", "never",
  ], { stdio: "inherit", cwd: sourceRoot, windowsHide: true });
  console.log("==> 5. Desktop packaging completed successfully!");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await packageDesktop(desktopPackageOptions(process.argv.slice(2)));
}
