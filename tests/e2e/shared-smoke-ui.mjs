import { expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** Exercise the shipped shared conversation shell; diagnostic output is never live-provider proof. */
export async function attachSmokeProject(page, repository) {
  await expect(page.getByRole("navigation", { name: "Conversations" })).toBeVisible();
  await page.getByRole("button", { name: "Attach project", exact: true }).click();
  const attach = page.getByRole("dialog", { name: "Attach a project" });
  await attach.getByLabel("Project folder", { exact: true }).fill(repository);
  await attach.getByRole("button", { name: "Attach project", exact: true }).click();
  await expect(attach).toBeHidden();
  await page.getByRole("navigation", { name: "Conversations" }).getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page.getByLabel("Message HIVE")).toBeVisible();
  await page.getByRole("combobox", { name: "Workflow", exact: true }).selectOption("code");
}

export async function runSmokeDiagnostic(page, { providerName, message, report }) {
  const settings = page.getByRole("dialog", { name: "Preferences & Accessibility" });
  if (await settings.isVisible()) await settings.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Select model", exact: true }).click();
  await page.getByRole("listbox", { name: "Configured models" }).getByRole("group", { name: providerName }).getByRole("option", { name: "network-free", exact: true }).click();
  await page.getByLabel("Message HIVE").fill(message);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator(".project-run-status > span:first-child").last()).toHaveText("completed", { timeout: 30_000 });
  await expect(page.locator(".project-reading")).toContainText(report);
  await page.getByRole("button", { name: "View changes", exact: true }).click();
  const changes = page.getByRole("dialog", { name: "Changes and checks" });
  await expect(changes).toContainText("No checks were recorded. No pass is implied.");
}

export async function persistedSmokeDiagnostic(repository, userData, message) {
  const catalog = JSON.parse(await readFile(path.join(userData, "interface-v1", "catalog.json"), "utf8"));
  const session = catalog.sessions.find((entry) => entry.title === message);
  const run = session?.runs.at(-1);
  if (!run?.engineSessionId) throw new Error("Shared diagnostic history did not link its authoritative coding record.");
  const coding = JSON.parse(await readFile(path.join(repository, ".hivemind", "sessions", run.engineSessionId, "session.json"), "utf8"));
  return { sharedRunStatus: run.status, sharedSessionId: session.id, sharedRunId: run.id, codingSessionId: run.engineSessionId, sessionStatus: coding.status, report: coding.finalReport?.result, recordedChecks: run.checks.length, recordedPatches: run.patches.length };
}
