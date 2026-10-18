import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import type { DesktopCommand, GuardedGitActionPreview, GuardedGitPreviewInput } from "../../src/desktop/types";
import { HiveDesktopPage } from "./hive-desktop.page";

const exec = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const main = path.join(projectRoot, "dist", "desktop", "electron", "main.js");
const fixtureWorker = path.join(import.meta.dirname, "fixture-worker.mjs");
const electronExecutable: string = createRequire(import.meta.url)("electron");
declare global { interface Window { hiveE2EGitPreview?: GuardedGitActionPreview } }

test.describe.serial("HIVE shared project desktop", () => {
  let root: string;
  let repository: string;
  let userData: string;
  let app: ElectronApplication;
  let page: Page;
  let errors: string[];

  test.beforeEach(async () => {
    const scratch = path.resolve(process.env.HIVE_E2E_SCRATCH ?? path.join(projectRoot, "test-results", "shared-desktop"));
    await mkdir(scratch, { recursive: true });
    root = await mkdtemp(path.join(scratch, "case-"));
    await appendFile(process.env.HIVE_TASK_CLEANUP_MANIFEST ?? path.join(scratch, "cleanup-manifest.txt"), root + "\n");
    repository = path.join(root, "repository");
    userData = path.join(root, "app-data");
    for (const directory of ["profile", "roaming", "local", "temporary"]) await mkdir(path.join(root, directory), { recursive: true });
    await exec("git", ["init", "--initial-branch=main", repository]);
    await exec("git", ["config", "user.name", "HIVE E2E"], { cwd: repository });
    await exec("git", ["config", "user.email", "hive-e2e@example.invalid"], { cwd: repository });
    await writeFile(path.join(repository, "README.md"), "fixture\n", "utf8");
    await writeFile(path.join(repository, "hive-desktop-fixture.txt"), "baseline\n", "utf8");
    await exec("git", ["add", "README.md", "hive-desktop-fixture.txt"], { cwd: repository });
    await exec("git", ["commit", "-m", "fixture baseline"], { cwd: repository });
    const remote = path.join(root, "origin.git");
    await exec("git", ["init", "--bare", remote]);
    await exec("git", ["remote", "add", "origin", remote], { cwd: repository });
    await exec("git", ["push", "-u", "origin", "main"], { cwd: repository });
    ({ app, page, errors } = await launch(userData, root));
  });

  test.afterEach(async () => {
    if (app) await closeApp(app);
    assertNoRendererErrors(errors);
    // App profiles, credential envelopes and shared catalogs are retained:
    // maintenance policy forbids deleting databases and credentials.
    await appendFile(path.join(root, "retained-evidence.txt"), "Isolated fixture repository, catalog and profile retained for inspection.\n");
  });

  test("stores encrypted credentials, shares durable history, reviews actual evidence and guards exact Git actions", async () => {
    const hive = new HiveDesktopPage(page);
    await hive.expectCockpit();
    await hive.openRepository(repository);
    const secret = "e2e-secret-must-never-persist-123456";
    await hive.configureOpenAi(secret);
    await hive.approveOllama();
    await hive.send("Create the verified fixture change.");
    await hive.expectPhase("completed");
    await hive.openChanges();
    const changes = page.getByRole("dialog", { name: "Changes and checks" });
    await expect(changes).toContainText("hive-desktop-fixture.txt");
    await expect(changes).toContainText(/passed.*exit 0/);
    await changes.getByRole("button", { name: "Mark reviewed", exact: true }).click();
    await expect(changes).toContainText(/Reviewed/);

    const completed = await hive.selectedSession();
    const run = completed?.runs.at(-1);
    expect(run?.engineSessionId).toBeTruthy();
    expect(run?.reviewedAt).toBeTruthy();
    const codingSessionId = run!.engineSessionId!;
    await page.evaluate(() => { window.hiveDesktop.subscribe((event) => { if (event.type === "git.previewed") window.hiveE2EGitPreview = event.preview; }); });
    await changes.getByText("Git action settings", { exact: true }).click();
    await changes.getByLabel("Commit message", { exact: true }).fill("E2E verified exact fixture");
    await changes.getByRole("button", { name: "Preview commit", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "Confirm commit" });
    await expect(confirmation).toContainText("hive-desktop-fixture.txt");
    await expect.poll(() => page.evaluate(() => window.hiveE2EGitPreview?.confirmationToken)).toBeTruthy();
    const preview = await page.evaluate(() => window.hiveE2EGitPreview);
    if (!preview || preview.proposal.action !== "commit") throw new Error("The UI commit preview was not captured.");
    await confirmation.getByRole("button", { name: "Confirm commit", exact: true }).click();
    await expect(confirmation).toBeHidden();
    await expect(changes).toContainText(/committed/i);
    const replay = await hive.request({ type: "git.commit.confirm", requestId: crypto.randomUUID(), input: { confirmationToken: preview.confirmationToken, proposal: preview.proposal } });
    expect(replay.type).toBe("request.failed");
    await changes.getByRole("button", { name: "Close changes", exact: true }).click();
    const changed = (await exec("git", ["show", "--name-only", "--format=", "hive-coder/" + codingSessionId], { cwd: repository })).stdout.trim().split(/\r?\n/).filter(Boolean);
    expect(changed).toEqual(["hive-desktop-fixture.txt"]);

    await closeApp(app);
    expect(await containsText(root, secret)).toBe(false);
    ({ app, page, errors } = await launch(userData, root));
    const restored = new HiveDesktopPage(page);
    await restored.expectCockpit();
    await restored.selectThread("Create the verified fixture change.");
    expect((await restored.selectedSession())?.runs.at(-1)?.reviewedAt).toBeTruthy();
    await restored.send("Follow up with another verified turn.");
    await restored.expectPhase("completed");
    const followup = (await restored.selectedSession())?.runs.at(-1);
    expect(followup?.checks.some((check) => check.status === "passed" && check.exitCode === 0)).toBe(true);
    await restored.request({ type: "repository.open", requestId: crypto.randomUUID(), repositoryRoot: repository });
    const unsafeRemote = await restored.request({ type: "git.pull-request.preview", requestId: crypto.randomUUID(), input: { action: "pull-request", repositoryRoot: repository, codingSessionId: followup!.engineSessionId!, remote: "origin", base: "main", title: "Fixture PR", body: "Fixture evidence", draft: true } });
    expect(unsafeRemote.type).toBe("request.failed");
    if (unsafeRemote.type === "request.failed") expect(unsafeRemote.message).toMatch(/remote|origin|pull request|GitHub/i);
  });

  test("enforces concrete approvals, cancel acknowledgment, linked recovery and active archive conflicts", async () => {
    const hive = new HiveDesktopPage(page);
    await hive.openRepository(repository);
    await hive.approveOllama();
    await hive.send("[approval] create a fixture after approval");
    await hive.expectPhase("awaiting_approval");
    const approval = page.getByRole("region", { name: "Tool approval" });
    await expect(approval).toContainText("This action only");
    await expect(page.getByRole("button", { name: "Archive", exact: true })).toBeDisabled();
    await approval.getByRole("button", { name: "Decline", exact: true }).click();
    await hive.expectPhase("failed");
    expect(await readFile(path.join(repository, "hive-desktop-fixture.txt"), "utf8")).toBe("baseline\n");
    const denied = (await hive.selectedSession())?.runs.at(-1);
    expect(denied?.approvals[0].status).toBe("declined");

    await hive.send("[hold] wait for cancellation");
    await hive.expectPhase("running");
    const held = (await hive.selectedSession())!;
    const archiveRequestId = crypto.randomUUID();
    const archive = await hive.request({ type: "projects.action", requestId: archiveRequestId, action: { type: "session.archive", requestId: archiveRequestId, sessionId: held.id } });
    expect(archive.type).toBe("request.failed");
    if (archive.type === "request.failed") expect(archive.message).toMatch(/active|stop/i);
    await page.getByRole("button", { name: "Stop run", exact: true }).click();
    await hive.expectPhase("cancelled");
    const cancelled = (await hive.selectedSession())?.runs.at(-1);
    await page.getByRole("button", { name: "Continue in a new attempt", exact: true }).click();
    await hive.send("Continue with a verified fixture task");
    await hive.expectPhase("completed");
    const resumed = (await hive.selectedSession())?.runs.at(-1);
    expect(resumed?.parentRunId).toBe(cancelled?.id);
    expect(resumed?.id).not.toBe(cancelled?.id);
    expect(resumed?.patches[0]?.state).toBe("applied");

    await hive.send("[crash] terminate the fixture worker");
    await hive.expectPhase("interrupted");
    expect((await hive.selectedSession())?.runs.at(-1)?.summary).toMatch(/exit|worker|terminated/i);
    await hive.send("Create a disposable verified change.");
    await hive.expectPhase("completed");
    const latest = (await hive.selectedSession())?.runs.at(-1);
    const worktree = path.join(repository, ".hivemind", "worktrees", latest!.engineSessionId!);
    await stat(worktree);
    await hive.request({ type: "repository.open", requestId: crypto.randomUUID(), repositoryRoot: repository });
    const discarded = await confirmGit(hive, { action: "discard", repositoryRoot: repository, codingSessionId: latest!.engineSessionId! });
    expect(discarded.type).toBe("git.action-completed");
    await expect(stat(worktree)).rejects.toThrow();
  });

  test("updates two native windows without moving local focus or drafts and survives archive/restore", async () => {
    const first = new HiveDesktopPage(page);
    await first.openRepository(repository);
    await first.rename("Primary local selection");
    await page.getByLabel("Message HIVE").fill("Primary unsent draft");
    const primarySession = (await first.selectedSession())!;
    const opened = app.waitForEvent("window");
    await first.request({ type: "shell.open-view", requestId: crypto.randomUUID(), view: "coder" });
    const secondPage = await opened;
    const second = new HiveDesktopPage(secondPage);
    await second.expectCockpit();
    await secondPage.getByRole("navigation", { name: "Conversations" }).getByRole("button", { name: "New chat", exact: true }).click();
    await second.rename("Secondary local selection");
    await secondPage.getByLabel("Message HIVE").fill("Secondary unsent draft");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Primary local selection");
    await expect(page.getByLabel("Message HIVE")).toHaveValue("Primary unsent draft");
    await secondPage.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(secondPage.getByText("This chat is archived.")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Primary local selection");
    const shared = await first.snapshot();
    expect(shared.sessions.find((session) => session.id === primarySession.id)?.title).toBe("Primary local selection");
    expect(shared.sessions.some((session) => session.title === "Secondary local selection" && session.archived)).toBe(true);
    await secondPage.getByRole("button", { name: "Restore chat", exact: true }).click();
    await expect(secondPage.getByLabel("Message HIVE")).toHaveValue("Secondary unsent draft");
    await secondPage.close();
  });
});

async function confirmGit(hive: HiveDesktopPage, proposal: GuardedGitPreviewInput) {
  const type = proposal.action === "pull-request" ? "git.pull-request" : "git." + proposal.action;
  const preview = await hive.request({ type: type + ".preview", requestId: crypto.randomUUID(), input: proposal } as DesktopCommand);
  if (preview.type !== "git.previewed") return preview;
  return hive.request({ type: type + ".confirm", requestId: crypto.randomUUID(), input: { confirmationToken: preview.preview.confirmationToken, proposal } } as DesktopCommand);
}

async function launch(userData: string, root: string): Promise<{ app: ElectronApplication; page: Page; errors: string[] }> {
  const errors: string[] = [];
  const app = await electron.launch({
    executablePath: electronExecutable, args: [main], cwd: projectRoot,
    env: electronEnvironment(root, { HIVE_DESKTOP_TESTING: "1", HIVE_DESKTOP_TEST_USER_DATA: userData, HIVE_DESKTOP_TEST_WORKER_MODULE: fixtureWorker, HIVE_PROJECT_CATALOG: path.join(root, "shared-projects.json") }),
  });
  app.process().stderr?.on("data", (chunk) => { const message = "main stderr: " + String(chunk); errors.push(message); process.stderr.write(message); });
  const page = await app.firstWindow({ timeout: 15_000 });
  page.on("pageerror", (error) => errors.push("pageerror: " + error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push("console: " + message.text()); });
  await page.waitForLoadState("domcontentloaded");
  return { app, page, errors };
}
function electronEnvironment(root: string, testValues: Record<string, string>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "ProgramFiles", "ProgramFiles(x86)"]) if (process.env[key]) environment[key] = process.env[key];
  return { ...environment, USERPROFILE: path.join(root, "profile"), HOME: path.join(root, "profile"), APPDATA: path.join(root, "roaming"), LOCALAPPDATA: path.join(root, "local"), TEMP: path.join(root, "temporary"), TMP: path.join(root, "temporary"), ...testValues };
}
async function closeApp(app: ElectronApplication): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([app.close(), new Promise<void>((resolve) => { timer = setTimeout(() => { app.process().kill(); resolve(); }, 5_000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function containsText(root: string, needle: string): Promise<boolean> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) { if (await containsText(target, needle)) return true; }
    else if (entry.isFile() && (await stat(target)).size <= 2_000_000 && (await readFile(target)).includes(Buffer.from(needle))) return true;
  }
  return false;
}
function assertNoRendererErrors(errors: string[]): void {
  expect(errors.filter((message) => !message.includes("favicon") && !message.includes("Debugger ending on ws://")), errors.join("\n")).toEqual([]);
}
