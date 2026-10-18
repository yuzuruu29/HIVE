import { _electron as electron, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, appendFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const CREDENTIAL_PROVIDER = "packaged-credential-fixture";
const SMOKE_PROVIDER_NAME = "Internal packaged diagnostic";
const SMOKE_MESSAGE = "Complete the internal packaged smoke diagnostic.";
const SMOKE_REPORT = "Packaged utility process diagnostic completed without network access.";
const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
const outputDir = process.env.HIVE_RELEASE_DIR || packageJson.build?.directories?.output || "dist-binaries";
const executable = path.resolve(
  process.env.HIVE_DESKTOP_PACKAGED_EXE ??
  path.join(outputDir, "win-unpacked", "HIVE.exe")
);
await access(executable);
const exec = promisify(execFile);
const root = process.env.HIVE_PACKAGED_SMOKE_ROOT
  ? path.resolve(process.env.HIVE_PACKAGED_SMOKE_ROOT)
  : await mkdtemp(path.join(os.tmpdir(), "hive-packaged-smoke-"));
const manifest = path.resolve(process.env.HIVE_CLEANUP_MANIFEST ?? path.join(root, "cleanup-manifest.txt"));
const repository = path.join(root, "repository");
const screenshot = path.join(root, "packaged-smoke.png");
const evidenceFile = path.join(root, "packaged-smoke-evidence.json");
const userData = path.resolve(process.env.HIVE_PACKAGED_SMOKE_USER_DATA ?? path.join(root, "app-data"));
const userDataRelative = path.relative(root, userData);
if (!userDataRelative || userDataRelative.startsWith("..") || path.isAbsolute(userDataRelative)) throw new Error("Packaged smoke user data must be a new child of its test root.");
if (process.env.HIVE_PACKAGED_SMOKE_ROOT) await mkdir(root);
await appendFile(manifest, `${root}\n${repository}\n${userData}\n${manifest}\n${screenshot}\n${evidenceFile}\n`);
const secret = "packaged-smoke-secret-must-be-encrypted-123456";
const rendererErrors = [];
const cleanupErrors = [];
let app;
let modelServer;
let failure;
let evidence;
console.log(`Packaged smoke test root (retained for maintenance review): ${root}`);

try {
  let modelRequests = 0;
  modelServer = createServer((request, response) => {
    if (request.url !== "/v1/models" || request.method !== "GET" || request.headers.authorization !== `Bearer ${secret}`) {
      response.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "Unexpected packaged smoke fixture request." } }));
      return;
    }
    modelRequests += 1;
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data: [{ id: "packaged-credential-model" }] }));
  });
  await new Promise((resolve, reject) => {
    modelServer.once("error", reject);
    modelServer.listen(0, "127.0.0.1", resolve);
  });
  const fixtureBaseUrl = `http://127.0.0.1:${modelServer.address().port}/v1`;
  await exec("git", ["init", "--initial-branch=main", repository]);
  await exec("git", ["config", "user.name", "HIVE Packaged Smoke"], { cwd: repository });
  await exec("git", ["config", "user.email", "hive-smoke@example.invalid"], { cwd: repository });
  await writeFile(path.join(repository, "README.md"), "packaged smoke\n", "utf8");
  await exec("git", ["add", "README.md"], { cwd: repository });
  await exec("git", ["commit", "-m", "packaged smoke baseline"], { cwd: repository });
  app = await electron.launch({
    executablePath: executable,
    args: [],
    env: { ...process.env, TEMP: root, TMP: root, HIVE_DESKTOP_PACKAGED_SMOKE: "1", HIVE_DESKTOP_SMOKE_USER_DATA: userData },
  });
  app.process().stderr?.on("data", (chunk) => rendererErrors.push(`main stderr: ${String(chunk)}`));
  const runtime = await app.evaluate(({ app }) => ({ isPackaged: app.isPackaged, appPath: app.getAppPath(), version: app.getVersion(), executable: process.execPath }));
  if (!runtime.isPackaged || path.basename(runtime.appPath) !== "app.asar") throw new Error("Packaged smoke requires the actual packaged ASAR runtime.");
  const resourcesRoot = path.dirname(runtime.appPath);
  const unpackedFiles = await relativeFiles(path.join(resourcesRoot, "app.asar.unpacked"));
  const expectedWorker = path.join("dist", "desktop", "electron", "worker.mjs");
  if (JSON.stringify(unpackedFiles) !== JSON.stringify([expectedWorker])) throw new Error(`Unexpected unpacked application files: ${unpackedFiles.join(", ") || "none"}.`);
  const page = await app.firstWindow();
  page.on("pageerror", (error) => rendererErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") rendererErrors.push(message.text()); });
  await page.waitForLoadState("domcontentloaded");
  if ((await page.title()) !== "HIVE Desktop") throw new Error(`Unexpected packaged title: ${await page.title()}`);
  for (const selector of ["nav[aria-label='Global Navigation']", "main"]) await page.locator(selector).waitFor({ state: "visible", timeout: 15_000 });
  await page.getByLabel("Repository path").fill(repository);
  await page.getByRole("button", { name: /^Open(?: another)?$/ }).click();
  await expect(page.getByLabel("Repository path")).toHaveValue(repository);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Providers", exact: true }).click();
  await page.getByRole("button", { name: "+ Add OpenAI-compatible provider", exact: true }).click();
  await page.getByLabel("Provider name", { exact: true }).fill("Packaged credential fixture");
  await page.getByLabel("OpenAI-compatible base URL", { exact: true }).fill(fixtureBaseUrl);
  await page.getByLabel("Default model", { exact: true }).fill("packaged-credential-model");
  await page.getByRole("button", { name: "Save provider", exact: true }).click();
  const providerDialog = page.getByRole("dialog", { name: "Configure provider" });
  await page.getByLabel("API key").fill(secret);
  await page.getByRole("button", { name: "Store encrypted credential" }).click();
  await expect(providerDialog).toBeHidden();
  const envelopes = JSON.parse(await readFile(path.join(userData, "credentials.json"), "utf8"));
  const envelope = envelopes.find((entry) => entry.providerId === CREDENTIAL_PROVIDER);
  if (!envelope?.ciphertext || envelope.kind !== "api-key") throw new Error("Packaged safeStorage did not persist the encrypted fixture credential.");
  const roundTrip = await app.evaluate(({ safeStorage }, fixture) => safeStorage.isEncryptionAvailable()
    && safeStorage.decryptString(Buffer.from(fixture.ciphertext, "base64")) === fixture.secret, { ciphertext: envelope.ciphertext, secret });
  if (!roundTrip) throw new Error("Packaged safeStorage fixture credential did not decrypt correctly.");
  await expect.poll(() => modelRequests, { message: "Encrypted fixture credential reaches only the loopback model catalog." }).toBeGreaterThan(0);

  // Chat and Code share one model choice; the Chat composer holds the picker.
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.getByRole("button", { name: "Select model", exact: true }).click();
  const diagnosticModel = page.getByRole("listbox", { name: "Configured models" }).locator("li").filter({ has: page.getByText(SMOKE_PROVIDER_NAME, { exact: true }) }).getByRole("option");
  await diagnosticModel.click();
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await page.getByLabel("Message HIVE").fill(SMOKE_MESSAGE);
  await page.getByRole("button", { name: "Send task", exact: true }).click();
  const inspector = page.getByRole("complementary", { name: "Harness Inspector" });
  await inspector.getByRole("tab", { name: /^Run/ }).click();
  await expect(inspector.locator(".hive-evidence-row").filter({ hasText: "Active Run Status" })).toContainText("completed", { timeout: 30_000 });
  await inspector.getByRole("tab", { name: /^Evidence/ }).click();
  await expect(page.getByLabel("Verification evidence")).toContainText("Diagnostic objective and provider matched exactly.", { timeout: 15_000 });

  const persisted = await persistedDiagnostic(repository);
  if (persisted.threadStatus !== "completed") throw new Error(`Persisted thread status was ${persisted.threadStatus}.`);
  if (persisted.sessionStatus !== "completed" || persisted.report !== SMOKE_REPORT) throw new Error("Persisted coding session did not contain the deterministic completed report.");
  if (rendererErrors.length) throw new Error(`Packaged renderer errors:\n${rendererErrors.join("\n")}`);
  await page.screenshot({ path: screenshot, fullPage: true });
  evidence = {
    checkedAt: new Date().toISOString(), requestedExecutable: executable, runtime,
    selectedRoute: { providerId: "hive-packaged-smoke", model: "network-free" },
    resourcesRoot, unpackedFiles, credentialFixture: { providerId: CREDENTIAL_PROVIDER, encryptedEnvelopePersisted: true, osSafeStorageRoundTrip: roundTrip, loopbackModelRequests: modelRequests },
    persisted, assertions: { codeRunCompletedVisible: true, productionUtilityEvidenceVisible: true, exactPersistedReport: true, rendererErrorCount: 0 },
    screenshot, retainedRoot: root,
  };
  console.log("Packaged utility process completed and persisted its deterministic report.");
} catch (error) {
  failure = new Error(`${error.message}\nRenderer Errors:\n${rendererErrors.join("\n") || "none"}`);
} finally {
  try {
    if (app) await closeBounded(app, 15_000);
  } catch (error) {
    cleanupErrors.push(error);
  } finally {
    try {
      if (modelServer) {
        modelServer.closeIdleConnections();
        await new Promise((resolve, reject) => modelServer.close((error) => error ? reject(error) : resolve()));
      }
      if (await containsText(root, secret)) cleanupErrors.push(new Error("Packaged safeStorage smoke found the plaintext credential on disk."));
    } catch (error) {
      cleanupErrors.push(error);
    } finally {
      // Chromium profiles contain databases and encrypted credential envelopes;
      // retain them under the manifest instead of deleting protected file types.
      console.log(`Packaged smoke retained test profile and fixture repository: ${root}`);
    }
  }
}

if (failure || cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], "Packaged smoke failed.");
await writeFile(evidenceFile, `${JSON.stringify({ status: "passed", ...evidence, appClosed: true, plaintextCredentialAbsentOnDisk: true }, null, 2)}\n`, "utf8");
console.log(`Packaged smoke passed (safeStorage + production utility process): ${executable}`);
console.log(`Packaged smoke evidence: ${evidenceFile}`);

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
  const thread = threads.find((entry) => entry.title === SMOKE_MESSAGE);
  const run = thread?.runs.at(-1);
  if (!run) throw new Error("Packaged smoke thread/run was not persisted.");
  const session = JSON.parse(await readFile(path.join(repositoryRoot, ".hivemind", "sessions", run.codingSessionId, "session.json"), "utf8"));
  return { threadStatus: run.status, sessionStatus: session.status, report: session.finalReport?.result };
}

async function containsText(directory, needle) {
  const bytes = Buffer.from(needle);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) { if (await containsText(target, needle)) return true; }
    else if (entry.isFile()) {
      let tail = Buffer.alloc(0);
      for await (const chunk of createReadStream(target)) {
        const content = Buffer.concat([tail, chunk]);
        if (content.includes(bytes)) return true;
        tail = content.subarray(Math.max(0, content.length - bytes.length + 1));
      }
    }
  }
  return false;
}

async function relativeFiles(directory, relative = "") {
  const files = [];
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await relativeFiles(directory, child));
    else if (entry.isFile()) files.push(child);
  }
  return files.sort();
}
