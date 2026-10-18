import { chromium, expect } from "@playwright/test";
import { execFile, spawn } from "node:child_process";
import { access, appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const executable = path.resolve(process.env.HIVE_DESKTOP_PORTABLE_EXE ?? process.env.HIVE_DESKTOP_PACKAGED_EXE ?? "dist-binaries/HIVE-0.6.0-x64-portable.exe");
const requestedRoot = process.env.HIVE_PORTABLE_SMOKE_ROOT ?? process.env.HIVE_PACKAGED_SMOKE_ROOT;
if (!requestedRoot) throw new Error("HIVE_PORTABLE_SMOKE_ROOT must select a new task-owned scratch directory.");
const root = path.resolve(requestedRoot);
const repository = path.join(root, "repository");
const userData = path.join(root, "app-data");
const screenshot = path.join(root, "portable-smoke.png");
const evidenceFile = path.join(root, "portable-smoke-evidence.json");
const manifest = path.resolve(process.env.HIVE_CLEANUP_MANIFEST ?? path.join(root, "cleanup-manifest.txt"));
const message = "Complete the internal packaged smoke diagnostic.";
const report = "Packaged utility process diagnostic completed without network access.";
const providerName = "Internal packaged diagnostic";
await access(executable);
await mkdir(root);
await appendFile(manifest, `${[root, repository, userData, screenshot, evidenceFile, manifest].join("\n")}\n`);

const portReservation = createServer();
await new Promise((resolve, reject) => { portReservation.once("error", reject); portReservation.listen(0, "127.0.0.1", resolve); });
const port = portReservation.address().port;
await new Promise((resolve, reject) => portReservation.close((error) => error ? reject(error) : resolve()));

let wrapper;
let wrapperExit;
let exitResult;
let browser;
let page;
let runtime;
let extractedRoot;
let failure;
let evidence;
const rendererErrors = [];
const wrapperStdio = { stdout: "", stderr: "", limitPerStream: 32_768 };

try {
  await execute("git", ["init", "--initial-branch=main", repository]);
  await execute("git", ["config", "user.name", "HIVE Portable Smoke"], { cwd: repository });
  await execute("git", ["config", "user.email", "hive-smoke@example.invalid"], { cwd: repository });
  await writeFile(path.join(repository, "README.md"), "portable smoke\n", "utf8");
  await execute("git", ["add", "README.md"], { cwd: repository });
  await execute("git", ["commit", "-m", "portable smoke baseline"], { cwd: repository });

  wrapper = spawn(executable, [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TEMP: root, TMP: root, HIVE_DESKTOP_PACKAGED_SMOKE: "1", HIVE_DESKTOP_SMOKE_USER_DATA: userData },
  });
  for (const stream of ["stdout", "stderr"]) wrapper[stream].on("data", (chunk) => {
    wrapperStdio[stream] = (wrapperStdio[stream] + String(chunk)).slice(0, wrapperStdio.limitPerStream);
  });
  wrapperExit = new Promise((resolve, reject) => {
    wrapper.once("error", reject);
    wrapper.once("exit", (code, signal) => { exitResult = { code, signal }; resolve(exitResult); });
  });
  // Connect independently of wrapper stdio to test the actual extracted runtime.
  const endpoint = `http://127.0.0.1:${port}`;
  await until(async () => {
    if (wrapper.exitCode !== null) throw new Error(`Portable wrapper exited before CDP was ready (${wrapper.exitCode}).`);
    try { return (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(750) })).ok; }
    catch { return false; }
  }, 45_000, "Portable wrapper did not expose its actual Electron CDP endpoint.");
  browser = await chromium.connectOverCDP(endpoint);
  await until(async () => { page = browser.contexts()[0]?.pages()[0]; return Boolean(page); }, 15_000, "Portable Electron window did not appear.");
  page.on("pageerror", (error) => rendererErrors.push(error.message));
  page.on("console", (entry) => { if (entry.type() === "error") rendererErrors.push(entry.text()); });
  await page.waitForLoadState("domcontentloaded");
  await expect(page).toHaveTitle("HIVE Desktop");
  if (!page.url().startsWith("file:") || !page.url().includes("/app.asar/")) throw new Error("Portable window did not load the packaged ASAR renderer.");
  const processes = await extractionProcesses();
  runtime = processes.find((entry) => entry.ParentProcessId === wrapper.pid && entry.Name.toLowerCase() === "hive.exe");
  if (!runtime) throw new Error("The requested portable wrapper did not own a HIVE.exe runtime inside its scratch extraction.");
  extractedRoot = path.dirname(runtime.ExecutablePath);
  await appendFile(manifest, `${extractedRoot}\n`);
  const unpackedFiles = await relativeFiles(path.join(extractedRoot, "resources", "app.asar.unpacked"));
  if (JSON.stringify(unpackedFiles) !== JSON.stringify([path.join("dist", "desktop", "electron", "worker.mjs")])) throw new Error("Portable payload did not unpack exactly the production utility worker.");

  await page.getByLabel("Repository path").fill(repository);
  await page.getByRole("button", { name: /^Open(?: another)?$/ }).click();
  await expect(page.getByLabel("Repository path")).toHaveValue(repository);
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.getByRole("button", { name: "Select model", exact: true }).click();
  const diagnosticModel = page.getByRole("listbox", { name: "Configured models" }).locator("li").filter({ has: page.getByText(providerName, { exact: true }) }).getByRole("option");
  await diagnosticModel.click();
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await page.getByLabel("Message HIVE").fill(message);
  await page.getByRole("button", { name: "Send task", exact: true }).click();
  const inspector = page.getByRole("complementary", { name: "Harness Inspector" });
  await inspector.getByRole("tab", { name: /^Run/ }).click();
  await expect(inspector.locator(".hive-evidence-row").filter({ hasText: "Active Run Status" })).toContainText("completed", { timeout: 30_000 });
  await inspector.getByRole("tab", { name: /^Evidence/ }).click();
  await expect(page.getByLabel("Verification evidence")).toContainText("Diagnostic objective and provider matched exactly.", { timeout: 15_000 });
  const threadRoot = path.join(repository, ".hivemind", "threads");
  const threads = await Promise.all((await readdir(threadRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => readFile(path.join(threadRoot, entry.name, "thread.json"), "utf8").then(JSON.parse)));
  const thread = threads.find((entry) => entry.title === message);
  const run = thread?.runs.at(-1);
  if (run?.status !== "completed") throw new Error("Portable run was not persisted as completed.");
  const session = JSON.parse(await readFile(path.join(repository, ".hivemind", "sessions", run.codingSessionId, "session.json"), "utf8"));
  if (session.status !== "completed" || session.finalReport?.result !== report) throw new Error("Portable session did not persist the exact diagnostic report.");
  if (rendererErrors.length) throw new Error(`Portable renderer errors: ${rendererErrors.join("\n")}`);
  await page.screenshot({ path: screenshot, fullPage: true });
  evidence = {
    checkedAt: new Date().toISOString(), requestedExecutable: executable, wrapperPid: wrapper.pid,
    runtime, rendererUrl: page.url(), extractedRoot, unpackedFiles,
    selectedRoute: { providerId: "hive-packaged-smoke", model: "network-free" },
    assertions: { packagedAsarRenderer: true, codeRunCompletedVisible: true, productionUtilityEvidenceVisible: true, exactPersistedReport: true, rendererErrorCount: 0 },
    persisted: { threadStatus: run.status, sessionStatus: session.status, report: session.finalReport.result },
    screenshot, retainedRoot: root,
  };
} catch (error) {
  failure = error;
} finally {
  try {
    if (page && !page.isClosed()) await page.close();
    if (wrapperExit) {
      const exit = await bounded(wrapperExit, 20_000, "Portable wrapper did not exit after closing its window.");
      if (exit.code !== 0 || exit.signal) throw new Error(`Portable wrapper exited with ${exit.code ?? exit.signal}.`);
      if (evidence) evidence.wrapperExit = exit;
    }
    if (extractedRoot) {
      await until(async () => {
        try { await access(extractedRoot); return false; }
        catch (error) { if (error.code === "ENOENT") return true; throw error; }
      }, 10_000, "Portable wrapper left its extraction directory behind.");
      if ((await extractionProcesses()).length) throw new Error("Portable HIVE processes remained under the owned extraction root.");
      if (evidence) Object.assign(evidence.assertions, { wrapperExitZero: true, extractionRemoved: true, noExtractionProcesses: true });
    }
    if (browser) await browser.close();
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], "Portable smoke and close checks failed.") : error;
    if (wrapper && wrapper.exitCode === null) {
      try {
        await execute("taskkill.exe", ["/PID", String(wrapper.pid), "/T", "/F"], { windowsHide: true });
        await bounded(wrapperExit, 5_000, "Task-owned portable wrapper resisted forced shutdown.");
      } catch (cleanupError) {
        failure = new AggregateError([failure, cleanupError], "Portable smoke failed to stop its own wrapper.");
      }
    }
  }
}
await writeFile(evidenceFile, `${JSON.stringify({
  status: failure ? "failed" : "passed", ...evidence,
  requestedExecutable: executable, wrapperPid: wrapper?.pid, wrapperExit: exitResult,
  wrapperStdio, rendererErrors, failure: failure ? errorDetails(failure) : undefined,
  retainedRoot: root,
}, null, 2)}\n`, "utf8");
if (failure) throw failure;
console.log(`Actual portable wrapper smoke passed: ${evidenceFile}`);

function errorDetails(error) {
  return { name: error.name, message: error.message, ...(error instanceof AggregateError ? { errors: error.errors.map(errorDetails) } : {}) };
}

async function extractionProcesses() {
  const prefix = `${root}${path.sep}`.replaceAll("'", "''");
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${prefix}', [StringComparison]::OrdinalIgnoreCase) } | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath | ConvertTo-Json -Compress`;
  const { stdout } = await execute("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true });
  const parsed = stdout.trim() ? JSON.parse(stdout) : [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function until(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(message);
}

async function bounded(operation, timeoutMs, message) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
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
