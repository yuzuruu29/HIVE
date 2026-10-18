#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const executeFile = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const windows = process.platform === "win32";
const packageName = "@uzzy-malolos/hive";
const skillDirectory = "skills/hive-mind-council/skills/hive-mind-council";
const commandTimeout = 30_000;
const packTimeout = 180_000;
const installTimeout = 240_000;

function progress(message) {
  console.log(`[test:package] ${message}`);
}

function npmConfig(name) {
  return process.env[`npm_config_${name}`] ?? process.env[`NPM_CONFIG_${name.toUpperCase()}`];
}

async function findNpmCli() {
  const nodeDirectory = path.dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    path.join(nodeDirectory, "node_modules/npm/bin/npm-cli.js"),
    path.resolve(nodeDirectory, "../lib/node_modules/npm/bin/npm-cli.js"),
  ];
  for (const directory of (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const unquoted = directory.replace(/^"|"$/g, "");
    candidates.push(path.join(unquoted, "node_modules/npm/bin/npm-cli.js"));
    if (!windows) {
      candidates.push(await fs.realpath(path.join(unquoted, "npm")).catch(() => undefined));
    }
  }
  for (const candidate of candidates) {
    if (candidate && /^npm-cli\.[cm]?js$/i.test(path.basename(candidate))
      && await fs.stat(candidate).then((stat) => stat.isFile(), () => false)) {
      return path.resolve(candidate);
    }
  }
  throw new Error("Cannot locate npm-cli.js. Run this script with npm run test:package, or install npm alongside Node.js.");
}

async function run(label, executable, args, options = {}) {
  const timeout = options.timeout ?? commandTimeout;
  const command = executeFile(executable, args, {
    ...options,
    timeout: timeout + 10_000,
    killSignal: "SIGKILL",
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    detached: !windows,
    shell: false,
    encoding: "utf8",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    const child = command.child;
    if (!child.pid) return;
    // Kill lifecycle/shim descendants too, before cleanup removes their cwd.
    if (windows) {
      execFile("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        env: options.env, windowsHide: true, timeout: 5_000, killSignal: "SIGKILL",
      }, () => child.kill("SIGKILL"));
    } else {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }
  }, timeout);
  timer.unref();
  try {
    return await command;
  } catch (error) {
    const output = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
    const detail = timedOut || error.killed ? `timed out after ${timeout} ms` : error.message;
    throw new Error(`${label} failed: ${detail}${output ? `\n${output}` : ""}`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

async function isolatedEnvironment(temporaryRoot) {
  // Copy only OS/runtime and transport settings, never provider keys, NODE_OPTIONS,
  // npm credentials, inherited lifecycle configuration, or application state paths.
  const allowed = new Set([
    "path", "pathext", "systemroot", "windir", "comspec", "lang", "lc_all", "lc_ctype", "tz",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy", "node_extra_ca_certs", "ssl_cert_file", "ssl_cert_dir",
  ]);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase())));
  const home = path.join(temporaryRoot, "home");
  const temp = path.join(temporaryRoot, "tmp");
  const userConfig = path.join(temporaryRoot, "user.npmrc");
  const globalConfig = path.join(temporaryRoot, "global.npmrc");
  await Promise.all([fs.mkdir(home), fs.mkdir(temp), fs.writeFile(userConfig, ""), fs.writeFile(globalConfig, "")]);
  Object.assign(environment, {
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: path.parse(home).root.replace(/[\\/]$/, ""),
    HOMEPATH: home.slice(path.parse(home).root.length - (windows ? 1 : 0)),
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
    CI: "true",
    NO_COLOR: "1",
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: globalConfig,
    npm_config_registry: npmConfig("registry") ?? "https://registry.npmjs.org/",
    npm_config_cache: npmConfig("cache") ?? (windows && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "npm-cache") : path.join(os.homedir(), ".npm")),
    npm_config_update_notifier: "false",
  });
  for (const name of ["proxy", "https_proxy", "noproxy", "cafile", "ca", "strict_ssl"]) {
    const value = npmConfig(name);
    if (value !== undefined) environment[`npm_config_${name}`] = value;
  }
  // npm lifecycle hooks and npm-generated shims must use this Node installation.
  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
  environment[pathKey] = [path.dirname(process.execPath), environment[pathKey] ?? ""].join(path.delimiter);
  return environment;
}

async function assertMissing(filename, message) {
  await assert.rejects(fs.lstat(filename), { code: "ENOENT" }, message);
}

async function stageSources(staging) {
  const inputs = ["package.json", "tsconfig.json", "src", "bin", "skills", "docs", "README.md", "LICENSE", "NOTICE.md", "scripts"];
  for (const input of inputs) {
    await fs.cp(path.join(root, input), path.join(staging, input), {
      recursive: true,
      filter: (source) => !["node_modules", "dist", ".git"].includes(path.basename(source)),
    });
  }
  const privateFiles = [
    ".claude/package-smoke-private.md", ".env", ".env.local", ".npmrc",
    ".hive/providers.json", ".hive/sessions/package-smoke-private.json",
    ".hivemind/coder-tasks/package-smoke-private.json", ".superpowers/package-smoke-private.md", ".zcode/package-smoke-private.md",
    "src/package-smoke-private.txt", "tests/package-smoke-private.test.mjs",
    "desktop/package-smoke-private.txt", "web/package-smoke-private.txt", "scripts/package-smoke-private.txt",
    "dist-binaries/package-smoke-private.txt", "dist-desktop/package-smoke-private.txt", "dist-web/package-smoke-private.txt",
    "release/package-smoke-private.txt", "release-dist/package-smoke-private.txt",
    "test-results/package-smoke-private.txt", "playwright-report/package-smoke-private.txt",
    "bin/.env", `${skillDirectory}/agents/.env`, `${skillDirectory}/references/package-smoke-private.txt`,
  ];
  for (const filename of privateFiles) {
    const destination = path.join(staging, filename);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    // A comment also makes the .npmrc marker inert when npm reads project config.
    await fs.writeFile(destination, "# HIVE_NPM_PACKAGE_PRIVATE_MARKER\n");
  }
  await assertMissing(path.join(staging, "dist"), "Staging must have no dist before npm pack runs prepack.");
}

function packedMetadata(stdout) {
  // npm versions differ on whether lifecycle chatter precedes --json output.
  const start = stdout.lastIndexOf("\n[");
  try {
    const result = JSON.parse(start < 0 ? stdout.trim() : stdout.slice(start + 1));
    assert.equal(result.length, 1);
    return result[0];
  } catch (error) {
    throw new Error(`Cannot parse npm pack --json output:\n${stdout}`, { cause: error });
  }
}

function assertPackageContents(packed, manifest) {
  assert.equal(packed.name, packageName);
  assert.equal(packed.version, manifest.version);
  assert.equal(packed.bundled?.length ?? 0, 0, "Do not bundle development dependencies.");
  assert.ok(Array.isArray(packed.files) && packed.files.length > 0, "npm pack must report its tarball contents.");
  const files = new Set(packed.files.map((file) => file.path.replaceAll("\\", "/")));
  const required = [
    "package.json", "README.md", "LICENSE", "NOTICE.md", "bin/hive.mjs",
    manifest.main.replace(/^\.\//, ""), manifest.types.replace(/^\.\//, ""),
    "dist/cli.js", "dist/chat/skill-locate.js", "dist/chat/skill-protocol.js",
    "dist/tui/index.js", "dist/tui/app.js", "dist/tui/renderer.js",
    "dist/providers/registry.js", "dist/providers/commands.js", "dist/providers/setup.js",
    "dist/extensions/index.js", "dist/extensions/skill-files.js",
    `${skillDirectory}/SKILL.md`, `${skillDirectory}/agents/Queen.md`,
    "skills/hive-mind-council/LICENSE", "skills/hive-mind-council/README.md",
    "docs/CLI_BYOK_LOCAL.md", "docs/CLI_EXTENSIONS.md",
  ];
  for (const reference of ["council-protocol", "handoff-schema", "orchestration-presets", "role-contracts", "runtime-capabilities", "safety-policy", "verification-policy"]) {
    required.push(`${skillDirectory}/references/${reference}.md`);
  }
  for (const filename of required) assert.ok(files.has(filename), `Tarball is missing ${filename}. Check package.json files/prepack.`);
  for (const filename of files) {
    const allowed = ["package.json", "README.md", "LICENSE", "NOTICE.md", "skills/hive-mind-council/LICENSE", "skills/hive-mind-council/README.md"].includes(filename)
      || /^bin\/[^/]+\.mjs$/.test(filename)
      || /^dist\/.+\.(?:js|d\.ts)$/.test(filename)
      || /^docs\/[^/]+\.md$/.test(filename)
      || filename === `${skillDirectory}/SKILL.md`
      || (filename.startsWith(`${skillDirectory}/agents/`) || filename.startsWith(`${skillDirectory}/references/`)) && filename.endsWith(".md");
    assert.ok(allowed, `Unexpected tarball entry ${filename}; publish only CLI/library code, skill markdown, and notices/docs.`);
    assert.ok(!/(?:^|\/)(?:\.git|\.claude|\.env(?:\.[^/]*)?|\.npmrc|\.hive|\.hivemind|\.superpowers|\.zcode|node_modules|tests)(?:\/|$)/i.test(filename)
      && !/^(?:src|tests|desktop|web|scripts|build|dist-binaries|dist-desktop|dist-web|release|release-dist|test-results|playwright-report)\//.test(filename)
      && !filename.includes("package-smoke-private"), `Private/development state leaked into tarball: ${filename}`);
  }
  return files.size;
}

function consumerProbe(manifest) {
  return `import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const [installedRoot, unrelatedCwd] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const installedRequire = createRequire(path.join(installedRoot, "package.json"));
assert.equal(await fs.realpath(require.resolve(${JSON.stringify(packageName)})), await fs.realpath(path.join(installedRoot, ${JSON.stringify(manifest.main)})));
const hive = await import(${JSON.stringify(packageName)});
assert.equal(typeof hive.runCoderCli, "function", "Installed library must export runCoderCli");
for (const module of ["dist/tui/index.js", "dist/providers/commands.js", "dist/extensions/index.js"]) {
  await import(pathToFileURL(path.join(installedRoot, module)).href);
}
for (const dependency of ["typescript", "tsc", "electron"]) {
  for (const resolver of [require, installedRequire]) {
    assert.throws(() => resolver.resolve(dependency + "/package.json"), { code: "MODULE_NOT_FOUND" }, dependency + " must not be installed in the consumer");
  }
}
const { locateSkillRoot } = await import(pathToFileURL(path.join(installedRoot, "dist/chat/skill-locate.js")).href);
const located = await locateSkillRoot(unrelatedCwd);
assert.ok(located, "Installed skill fallback must work from an unrelated cwd");
const expected = await fs.realpath(path.join(installedRoot, ${JSON.stringify(skillDirectory)}));
assert.equal(await fs.realpath(located), expected, "Skill must resolve inside the installed package, not the source checkout");
const { loadAgentPrompt, loadProtocolDigest } = await import(pathToFileURL(path.join(installedRoot, "dist/chat/skill-protocol.js")).href);
assert.match(await loadAgentPrompt(located, "Queen"), /Queen/i);
assert.ok((await loadProtocolDigest(located)).length > 100, "Installed reference digest must not be empty");
assert.match(await fs.readFile(path.join(installedRoot, "LICENSE"), "utf8"), /MIT License/);
assert.match(await fs.readFile(path.join(installedRoot, "skills/hive-mind-council/LICENSE"), "utf8"), /Apache License[\\s\\S]*Version 2\\.0/);
assert.match(await fs.readFile(path.join(installedRoot, "NOTICE.md"), "utf8"), /Apache-2\\.0/);
console.log("Scoped library import, runtime modules, skill fallback, licenses, and production-only dependencies passed.");
`;
}

async function main() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  assert.ok(major > 22 || major === 22 && minor >= 17, "test:package requires Node.js >=22.17.0.");
  const npmCli = await findNpmCli();
  // Spaces intentionally exercise npm's prefix handling and the generated shims.
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hive npm package-"));
  const staging = path.join(temporaryRoot, "staging");
  const compilerLink = path.join(staging, "node_modules");
  let compilerLinked = false;
  try {
    const consumer = path.join(temporaryRoot, "consumer");
    const unrelatedCwd = path.join(temporaryRoot, "unrelated cwd");
    const prefix = path.join(consumer, "global prefix");
    const tarballs = path.join(temporaryRoot, "tarballs");
    await Promise.all([staging, consumer, unrelatedCwd, tarballs].map((directory) => fs.mkdir(directory)));
    const environment = await isolatedEnvironment(temporaryRoot);
    const npm = (label, args, cwd, timeout) => run(label, process.execPath, [npmCli, ...args], { cwd, env: environment, timeout });

    progress("Staging source inputs without dist; linking the existing compiler only.");
    await stageSources(staging);
    const manifest = JSON.parse(await fs.readFile(path.join(staging, "package.json"), "utf8"));
    assert.equal(manifest.name, packageName, `Expected release metadata for ${packageName}; finish the manifest update before running test:package.`);
    assert.ok(manifest.scripts?.prepack, "Add a prepack build hook before running test:package.");
    assert.equal(manifest.bin?.hive?.replace(/^\.\//, ""), "bin/hive.mjs");
    assert.equal(manifest.main?.replace(/^\.\//, ""), "dist/index.js");
    assert.equal(manifest.types?.replace(/^\.\//, ""), "dist/index.d.ts");
    const compilerModules = path.dirname(path.dirname(createRequire(import.meta.url).resolve("typescript/package.json")));
    await fs.access(path.join(compilerModules, "typescript/bin/tsc"));
    await fs.symlink(compilerModules, compilerLink, windows ? "junction" : "dir");
    compilerLinked = true;

    progress("Packing with real lifecycle hooks; prepack must generate dist.");
    const packed = packedMetadata((await npm("npm pack (including prepack)", [
      "pack", "--json", "--ignore-scripts=false", "--loglevel=error", "--pack-destination", tarballs,
    ], staging, packTimeout)).stdout);
    await fs.access(path.join(staging, manifest.main));
    await fs.access(path.join(staging, manifest.types));
    const fileCount = assertPackageContents(packed, manifest);
    assert.equal(path.basename(packed.filename), packed.filename, "npm pack must return a local tarball filename.");
    const tarball = path.join(tarballs, packed.filename);
    await fs.access(tarball);
    // Unlink explicitly before any recursive cleanup; never touch the root tree.
    await fs.unlink(compilerLink);
    compilerLinked = false;

    progress(`Verified ${fileCount} tarball entries; installing the local tarball into an isolated global prefix.`);
    await npm("Global-prefix production install of local tarball", [
      "install", "--global", "--prefix", prefix, tarball, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund",
      "--no-package-lock", "--prefer-offline", "--fetch-retries=1", "--fetch-retry-mintimeout=1000",
      "--fetch-retry-maxtimeout=2000", "--fetch-timeout=20000", "--loglevel=error",
    ], consumer, installTimeout);
    const globalModules = path.join(prefix, ...(windows ? [] : ["lib"]), "node_modules");
    const installedRoot = path.join(globalModules, ...packageName.split("/"));
    const installedManifest = JSON.parse(await fs.readFile(path.join(installedRoot, "package.json"), "utf8"));
    assert.equal(installedManifest.name, packageName);
    assert.equal(installedManifest.version, manifest.version);
    const cli = path.join(installedRoot, "bin/hive.mjs");
    const commandOptions = { cwd: unrelatedCwd, env: environment };

    progress("Checking installed CLI help, offline provider presets, and the actual global hive shim.");
    const help = await run("Installed CLI --help", process.execPath, [cli, "--help"], commandOptions);
    assert.match(help.stdout, /hive/i);
    assert.match(help.stdout, /providers/);
    const presetsOutput = await run("Installed CLI providers presets --json", process.execPath, [cli, "providers", "presets", "--json"], commandOptions);
    const presets = JSON.parse(presetsOutput.stdout);
    assert.ok(Array.isArray(presets), "providers presets --json must return an array.");
    const ids = presets.map((preset) => preset.id);
    assert.equal(new Set(ids).size, ids.length, "Provider preset IDs must be unique.");
    for (const id of ["openai", "anthropic", "google", "openrouter", "custom", "hive-cloud", "opencode", "kilo", "cline", "ollama", "local", "hermes", "chatgpt"]) {
      assert.ok(ids.includes(id), `Installed CLI is missing provider preset ${id}.`);
    }
    const shim = path.join(prefix, ...(windows ? [] : ["bin"]), windows ? "hive.cmd" : "hive");
    await fs.access(shim);
    const shimHelp = windows
      // Only this .cmd shim needs cmd.exe. Fixed arguments and a quoted environment
      // reference avoid interpreting spaces, &, %, or ! in the owned prefix path.
      ? await run("Installed global hive.cmd --help", environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe", [
        "/d", "/v:off", "/s", "/c", '\"\"%HIVE_NPM_SMOKE_SHIM%\" --help\"',
      ], { ...commandOptions, windowsVerbatimArguments: true, env: { ...environment, HIVE_NPM_SMOKE_SHIM: shim } })
      : await run("Installed global hive --help", shim, ["--help"], commandOptions);
    assert.equal(shimHelp.stdout.trim(), help.stdout.trim(), "The generated hive shim must run the installed CLI.");

    progress("Checking scoped imports, production dependencies, licenses, and installed skill fallback from unrelated cwd.");
    // Expose only the owned global install to a normal bare ESM import. No second
    // install/network fetch and no access to the checkout's development modules.
    await fs.symlink(globalModules, path.join(consumer, "node_modules"), windows ? "junction" : "dir");
    const probe = path.join(consumer, "smoke.mjs");
    await fs.writeFile(probe, consumerProbe(manifest));
    await run("Installed library and skill probe", process.execPath, [probe, installedRoot, unrelatedCwd], commandOptions);
    progress(`Passed: ${packageName}@${manifest.version} packs, installs globally, and runs without development dependencies.`);
  } finally {
    // rm never traverses directory symlinks/junctions, even if unlink is busy.
    if (compilerLinked) await fs.unlink(compilerLink).catch(() => undefined);
    try {
      await fs.rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
    } catch (error) {
      console.error(`[test:package] Cleanup failed for owned temporary directory ${temporaryRoot}: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(`[test:package] ${error.message}`);
  process.exitCode = 1;
});
