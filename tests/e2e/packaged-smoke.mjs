import { _electron as electron, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const SMOKE_PROVIDER = "hive-packaged-smoke";
const SMOKE_MESSAGE = "Complete the internal packaged smoke diagnostic.";
const SMOKE_REPORT = "Packaged utility process diagnostic completed without network access.";
const executable = path.resolve(process.env.HIVE_DESKTOP_PACKAGED_EXE ?? path.join("release", "win-unpacked", "HIVE.exe"));
await access(executable);
const exec = promisify(execFile);
const root = await mkdtemp(path.join(os.tmpdir(), "hive-packaged-smoke-"));
const repository = path.join(root, "repository");
const userData = path.join(root, "app-data");
const secret = "packaged-smoke-secret-must-be-encrypted-123456";
const rendererErrors = [];
const cleanupErrors = [];
let app;
let failure;

try {
  const unpackedFiles = await relativeFiles(path.join(path.dirname(executable), "resources", "app.asar.unpacked"));
  const expectedWorker = path.join("dist", "desktop", "electron", "worker.mjs");
  if (JSON.stringify(unpackedFiles) !== JSON.stringify([expectedWorker])) throw new Error(`Unexpected unpacked application files: ${unpackedFiles.join(", ") || "none"}.`);
  await exec("git", ["init", "--initial-branch=main", repository]);
  await exec("git", ["config", "user.name", "HIVE Packaged Smoke"], { cwd: repository });
  await exec("git", ["config", "user.email", "hive-smoke@example.invalid"], { cwd: repository });
  await writeFile(path.join(repository, "README.md"), "packaged smoke\n", "utf8");
  await exec("git", ["add", "README.md"], { cwd: repository });
  await exec("git", ["commit", "-m", "packaged smoke baseline"], { cwd: repository });
  app = await electron.launch({
    executablePath: executable,
    args: [],
    env: { ...process.env, HIVE_DESKTOP_PACKAGED_SMOKE: "1", HIVE_DESKTOP_SMOKE_USER_DATA: userData },
  });
  app.process().stderr?.on("data", (chunk) => rendererErrors.push(`main stderr: ${String(chunk)}`));
  const page = await app.firstWindow();
  page.on("pageerror", (error) => rendererErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") rendererErrors.push(message.text()); });
  await page.waitForLoadState("domcontentloaded");
  if ((await page.title()) !== "HIVE Desktop") throw new Error(`Unexpected packaged title: ${await page.title()}`);
  for (const selector of ["nav[aria-label='Repositories and threads']", "main", "aside[aria-label='Run inspector']"]) await page.locator(selector).waitFor({ state: "visible", timeout: 15_000 });
  await page.getByLabel("Repository path").fill(repository);
  await page.getByRole("button", { name: /^Open$/ }).click();
  await page.getByLabel("New thread title").waitFor({ state: "visible" });

  await page.getByLabel("Provider").selectOption("openai");
  await page.getByRole("button", { name: "Configure provider" }).click();
  await page.getByLabel("API key").fill(secret);
  await page.getByRole("button", { name: "Store encrypted credential" }).click();
  await expect(page.getByText("Credential encrypted and stored.")).toBeVisible();

  await page.getByLabel("Provider").selectOption(SMOKE_PROVIDER);
  await page.getByLabel("New thread title").fill("Packaged worker smoke");
  await page.getByRole("button", { name: "Create thread" }).click();
  await page.getByLabel("Message HIVE").fill(SMOKE_MESSAGE);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator("aside[aria-label='Run inspector'] .status-pill").filter({ hasText: "completed" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("tab", { name: /report/i }).click();
  await expect(page.getByRole("heading", { name: SMOKE_REPORT })).toBeVisible({ timeout: 15_000 });

  const persisted = await persistedDiagnostic(repository);
  if (persisted.threadStatus !== "completed") throw new Error(`Persisted thread status was ${persisted.threadStatus}.`);
  if (persisted.sessionStatus !== "completed" || persisted.report !== SMOKE_REPORT) throw new Error("Persisted coding session did not contain the deterministic completed report.");
  if (rendererErrors.length) throw new Error(`Packaged renderer errors:\n${rendererErrors.join("\n")}`);
  console.log("Packaged utility process completed and persisted its deterministic report.");
} catch (error) {
  failure = error;
} finally {
  try {
    if (app) await closeBounded(app, 15_000);
  } catch (error) {
    cleanupErrors.push(error);
  } finally {
    try {
      if (await containsText(root, secret)) cleanupErrors.push(new Error("Packaged safeStorage smoke found the plaintext credential on disk."));
    } catch (error) {
      cleanupErrors.push(error);
    } finally {
      try { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); }
      catch (error) { cleanupErrors.push(error); }
    }
  }
}

if (failure || cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], "Packaged smoke failed.");
console.log(`Packaged smoke passed (safeStorage + production utility process): ${executable}`);

async function closeBounded(electronApp, timeoutMs) {
  const processHandle = electronApp.process();
  const closed = await Promise.race([electronApp.close().then(() => true, () => false), new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs))]);
  if (closed) return;
  processHandle.kill();
  const exited = await Promise.race([new Promise((resolve) => processHandle.once("exit", () => resolve(true))), new Promise((resolve) => setTimeout(() => resolve(false), 5_000))]);
  if (!exited && processHandle.exitCode === null) throw new Error("Packaged app resisted force-kill after close timeout.");
  throw new Error("Packaged app required force-kill after close timeout.");
}

async function persistedDiagnostic(repositoryRoot) {
  const threadRoot = path.join(repositoryRoot, ".hivemind", "threads");
  const threadDirectories = await readdir(threadRoot, { withFileTypes: true });
  const threads = await Promise.all(threadDirectories.filter((entry) => entry.isDirectory()).map((entry) => readFile(path.join(threadRoot, entry.name, "thread.json"), "utf8").then(JSON.parse)));
  const thread = threads.find((entry) => entry.title === "Packaged worker smoke");
  const run = thread?.runs.at(-1);
  if (!run) throw new Error("Packaged smoke thread/run was not persisted.");
  const session = JSON.parse(await readFile(path.join(repositoryRoot, ".hivemind", "sessions", run.codingSessionId, "session.json"), "utf8"));
  return { threadStatus: run.status, sessionStatus: session.status, report: session.finalReport?.result };
}

async function containsText(directory, needle) {
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) { if (await containsText(target, needle)) return true; }
    else if (entry.isFile() && (await stat(target)).size <= 2_000_000 && (await readFile(target).catch(() => Buffer.alloc(0))).includes(Buffer.from(needle))) return true;
  }
  return false;
}

async function relativeFiles(directory, relative = "") {
  const files = [];
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true }).catch(() => [])) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await relativeFiles(directory, child));
    else if (entry.isFile()) files.push(child);
  }
  return files.sort();
}
