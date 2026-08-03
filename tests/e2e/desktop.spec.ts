import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { HiveDesktopPage } from "./hive-desktop.page";

const exec = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const main = path.join(projectRoot, "dist", "desktop", "electron", "main.js");
const fixtureWorker = path.join(import.meta.dirname, "fixture-worker.mjs");
const electronExecutable = path.join(projectRoot, "node_modules", "electron", "dist", "electron.exe");

test.describe.serial("HIVE Windows desktop companion", () => {
  let root: string;
  let repository: string;
  let userData: string;
  let app: ElectronApplication;
  let page: Page;
  let errors: string[];

  test.beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hive-desktop-e2e-"));
    repository = path.join(root, "repository");
    userData = path.join(root, "app-data");
    await exec("git", ["init", "--initial-branch=main", repository]);
    await exec("git", ["config", "user.name", "HIVE E2E"], { cwd: repository });
    await exec("git", ["config", "user.email", "hive-e2e@example.invalid"], { cwd: repository });
    await import("node:fs/promises").then(async ({ writeFile }) => {
      await writeFile(path.join(repository, "README.md"), "fixture\n", "utf8");
      await writeFile(path.join(repository, "hive-desktop-fixture.txt"), "baseline\n", "utf8");
    });
    await exec("git", ["add", "README.md", "hive-desktop-fixture.txt"], { cwd: repository });
    await exec("git", ["commit", "-m", "fixture baseline"], { cwd: repository });
    const remote = path.join(root, "origin.git");
    await exec("git", ["init", "--bare", remote]);
    await exec("git", ["remote", "add", "origin", remote], { cwd: repository });
    await exec("git", ["push", "-u", "origin", "main"], { cwd: repository });
    ({ app, page, errors } = await launch(userData));
  });

  test.afterEach(async () => {
    if (app) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        app.close(),
        new Promise<void>((resolve) => { timer = setTimeout(() => { app.process().kill(); resolve(); }, 5_000); }),
      ]).catch(() => app.process().kill());
      if (timer) clearTimeout(timer);
    }
    assertNoRendererErrors(errors);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test("onboards, encrypts provider credentials, restores threads, reviews changes, commits exact files, and refuses unsafe remote actions", async () => {
    const hive = new HiveDesktopPage(page);
    await hive.expectCockpit();
    await hive.openRepository(repository);
    const secret = "e2e-secret-must-never-persist-123456";
    await hive.configureOpenAi(secret);
    await hive.approveOllama();
    await hive.createThread("Desktop release flow");
    await hive.send("Create the verified fixture change.");
    await hive.expectPhase("completed");
    await hive.openTab("Changes");
    await expect(page.getByLabel("Read-only unified diff")).toContainText("hive-desktop-fixture.txt");
    await hive.previewAndConfirm("commit");
    await expect(page.getByText(/committed/i).last()).toBeVisible();
    const changed = (await exec("git", ["show", "--name-only", "--format=", "hive-coder/" + await currentSessionId(repository)], { cwd: repository })).stdout.trim().split(/\r?\n/).filter(Boolean);
    expect(changed).toEqual(["hive-desktop-fixture.txt"]);
    await app.close();
    expect(await containsText(userData, secret)).toBe(false);
    ({ app, page, errors } = await launch(userData));
    const restored = new HiveDesktopPage(page);
    await restored.expectCockpit();
    await restored.openRecent(repository);
    await restored.selectThread("Desktop release flow");
    await restored.openTab("Conversation");
    await restored.send("Follow up with another verified turn.");
    await restored.expectPhase("completed");
    await restored.openTab("Report");
    await expect(page.getByRole("heading", { name: "Deterministic desktop run complete" })).toBeVisible();
    await restored.openTab("Changes");
    await restored.previewAndConfirm("push");
    await expect(page.getByText(/Pushed hive-coder\//i).last()).toBeVisible();
    await restored.previewAndConfirm("PR");
    await expect(page.getByRole("alert")).toContainText(/remote|origin|pull request|GitHub CLI|GitHub/i);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("cooperatively pauses and resumes, cancels, then discards only the latest HIVE worktree", async () => {
    const hive = new HiveDesktopPage(page);
    await hive.openRepository(repository);
    await hive.createThread("Control flow");
    await hive.send("[hold] wait for cooperative pause");
    await hive.expectPhase("planning");
    await page.getByRole("button", { name: "Pause" }).click();
    await hive.expectPhase("paused");
    await page.getByRole("button", { name: "Resume" }).click();
    await hive.expectPhase("completed");
    await hive.send("[hold] wait for cancellation");
    await hive.expectPhase("planning");
    await page.getByRole("button", { name: "Cancel" }).click();
    await hive.expectPhase("cancelled");
    await hive.send("Create a disposable verified change.");
    await hive.expectPhase("completed");
    const sessionId = await currentSessionId(repository);
    const worktree = path.join(repository, ".hivemind", "worktrees", sessionId);
    await stat(worktree);
    await hive.openTab("Changes");
    await hive.previewAndConfirm("discard");
    await expect(page.getByText(/discard completed/i).last()).toBeVisible();
    await expect(stat(worktree)).rejects.toThrow();
  });
});

async function launch(userData: string): Promise<{ app: ElectronApplication; page: Page; errors: string[] }> {
  const errors: string[] = [];
  const app = await electron.launch({
    executablePath: electronExecutable, args: [main], cwd: projectRoot,
    env: electronEnvironment({ HIVE_DESKTOP_TESTING: "1", HIVE_DESKTOP_TEST_USER_DATA: userData, HIVE_DESKTOP_TEST_WORKER_MODULE: fixtureWorker }),
  });
  app.process().stderr?.on("data", (chunk) => { const message = `main stderr: ${String(chunk)}`; errors.push(message); process.stderr.write(message); });
  const page = await Promise.race([
    app.firstWindow(),
    new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error(`Electron window did not open. ${errors.join(" ")}`)), 15_000); timer.unref(); }),
  ]);
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
  await page.waitForLoadState("domcontentloaded");
  return { app, page, errors };
}

function electronEnvironment(testValues: Record<string, string>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "COMSPEC", "PATHEXT", "ProgramFiles", "ProgramFiles(x86)"]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return { ...environment, ...testValues };
}

async function currentSessionId(repository: string): Promise<string> {
  const threads = path.join(repository, ".hivemind", "threads");
  const [thread] = await readdir(threads);
  const record = JSON.parse(await readFile(path.join(threads, thread, "thread.json"), "utf8"));
  return record.runs.at(-1).codingSessionId;
}

async function containsText(root: string, needle: string): Promise<boolean> {
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) { if (await containsText(target, needle)) return true; }
    else if (entry.isFile() && (await stat(target)).size <= 2_000_000 && (await readFile(target).catch(() => Buffer.alloc(0))).includes(Buffer.from(needle))) return true;
  }
  return false;
}

function assertNoRendererErrors(errors: string[]): void {
  expect(errors.filter((message) => !message.includes("favicon") && !message.includes("Debugger ending on ws://")), errors.join("\n")).toEqual([]);
}
