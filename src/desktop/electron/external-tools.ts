import { execFile as nodeExecFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { DesktopOpenEditorRequest, DesktopOpenExplorerRequest } from "../types.js";

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function rejectProtocol(value: string): void {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) || value.startsWith("file:")) throw new Error("URLs and protocols are not accepted as workspace paths.");
}

export async function resolveWorkspaceTarget(repositoryRoot: string, target = ".", options: { mustExist?: boolean } = {}): Promise<string> {
  if (typeof repositoryRoot !== "string" || !path.isAbsolute(repositoryRoot)) throw new Error("Repository root must be absolute.");
  if (typeof target !== "string" || target.length === 0 || target.includes("\0")) throw new Error("Workspace target is invalid.");
  rejectProtocol(target);
  const canonicalRoot = await fs.realpath(repositoryRoot);
  const resolved = path.resolve(canonicalRoot, target);
  if (!contained(canonicalRoot, resolved)) throw new Error("Workspace target is outside the selected repository.");
  const relative = path.relative(canonicalRoot, resolved).replaceAll("\\", "/");
  if (relative === ".git" || relative.startsWith(".git/")) throw new Error("Protected Git metadata cannot be opened.");
  if (options.mustExist !== false) {
    const canonicalTarget = await fs.realpath(resolved);
    if (!contained(canonicalRoot, canonicalTarget)) throw new Error("Workspace target resolves outside the selected repository.");
    return canonicalTarget;
  }
  return resolved;
}

type ExecFileRunner = (file: string, args: readonly string[], options?: { cwd?: string; windowsHide?: boolean }) => Promise<void>;

export interface TrustedExecutableResolver { resolve(name: "code" | "cursor" | "devenv" | "wt" | "explorer" | "git" | "gh", repositoryRoot: string): Promise<string> }

export function assertTrustedExecutablePath(repositoryRoot: string, executable: string): string {
  if (!path.isAbsolute(executable) || contained(path.resolve(repositoryRoot), path.resolve(executable))) throw new Error("Refusing to launch an untrusted repository executable.");
  return executable;
}

function defaultExecFile(file: string, args: readonly string[], options?: { cwd?: string; windowsHide?: boolean }): Promise<void> {
  return new Promise((resolve, reject) => nodeExecFile(file, [...args], options ?? {}, (error) => error ? reject(error) : resolve()));
}

export class SystemTrustedExecutableResolver implements TrustedExecutableResolver {
  public async resolve(name: "code" | "cursor" | "devenv" | "wt" | "explorer" | "git" | "gh", repositoryRoot: string): Promise<string> {
    const root = await fs.realpath(repositoryRoot);
    const systemRoot = this.#outside(root, await fs.realpath(process.env.SystemRoot || "C:\\Windows"));
    if (name === "explorer") return this.#outside(root, await fs.realpath(path.join(systemRoot, "explorer.exe")));
    const where = this.#outside(root, await fs.realpath(path.join(systemRoot, "System32", "where.exe")));
    const query = name === "code" ? "Code.exe" : name === "cursor" ? "Cursor.exe" : name === "devenv" ? "devenv.exe" : name === "wt" ? "wt.exe" : name === "git" ? "git.exe" : "gh.exe";
    const output = await new Promise<string>((resolve, reject) => nodeExecFile(where, [query], { cwd: systemRoot, windowsHide: true }, (error, stdout) => error ? reject(new Error(`Trusted executable ${name} is unavailable.`)) : resolve(String(stdout))));
    const candidates = output.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
    for (const candidate of candidates) {
      try { return this.#outside(root, await fs.realpath(candidate)); } catch { /* Try the next system lookup result. */ }
    }
    throw new Error(`Trusted executable ${name} is unavailable outside the selected repository.`);
  }

  #outside(repositoryRoot: string, executable: string): string {
    if (contained(repositoryRoot, executable)) throw new Error("Refusing to launch an executable from the selected repository.");
    if (!path.isAbsolute(executable)) throw new Error("Trusted executable resolution must return an absolute path.");
    return executable;
  }
}

export class DesktopExternalToolService {
  public constructor(
    private readonly editor: "vscode" | "cursor" | "visual-studio" = "vscode",
    private readonly execFile: ExecFileRunner = defaultExecFile,
    private readonly executables: TrustedExecutableResolver = new SystemTrustedExecutableResolver(),
  ) {}

  public async openEditor(input: DesktopOpenEditorRequest): Promise<void> {
    const root = await resolveWorkspaceTarget(input.repositoryRoot);
    const target = input.path ? await resolveWorkspaceTarget(root, input.path) : root;
    const location = input.line ? `${target}:${input.line}${input.column ? `:${input.column}` : ""}` : target;
    const executableName = this.editor === "cursor" ? "cursor" : this.editor === "visual-studio" ? "devenv" : "code";
    const executable = assertTrustedExecutablePath(root, await this.executables.resolve(executableName, root));
    const args = this.editor === "visual-studio" ? [target] : ["--reuse-window", "--goto", location];
    await this.execFile(executable, args, { cwd: root, windowsHide: true });
  }

  public async openTerminal(repositoryRoot: string): Promise<void> {
    const root = await resolveWorkspaceTarget(repositoryRoot);
    await this.execFile(assertTrustedExecutablePath(root, await this.executables.resolve("wt", root)), ["-d", root], { cwd: root, windowsHide: true });
  }

  public async openExplorer(input: DesktopOpenExplorerRequest): Promise<void> {
    const root = await resolveWorkspaceTarget(input.repositoryRoot);
    const target = input.path ? await resolveWorkspaceTarget(root, input.path) : root;
    const stat = await fs.stat(target);
    await this.execFile(assertTrustedExecutablePath(root, await this.executables.resolve("explorer", root)), stat.isDirectory() ? [target] : ["/select,", target], { cwd: root, windowsHide: true });
  }
}
