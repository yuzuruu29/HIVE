/** Canonical renderer-to-main command surface. Keep this array JSON-compatible for preload generation. */
export const DESKTOP_COMMAND_TYPES = [
  "repository.list", "repository.open", "thread.list", "thread.create", "thread.load", "thread.message.append", "thread.archive",
  "run.start", "run.pause", "run.resume", "run.cancel", "run.report", "provider.list", "provider.metadata", "provider.configure",
  "credential.list", "credential.metadata", "credential.set", "credential.replace", "credential.remove", "credential.test", "git.inspect",
  "changes.diff", "git.commit.preview", "git.commit.confirm", "git.push.preview", "git.push.confirm", "git.pull-request.preview",
  "git.pull-request.confirm", "git.discard.preview", "git.discard.confirm", "external.open-editor", "external.open-terminal", "external.open-explorer",
  "chat.list", "chat.create", "chat.load", "chat.archive", "chat.route", "chat.send", "chat.cancel"
] as const;

export type DesktopCommandType = (typeof DESKTOP_COMMAND_TYPES)[number];
export const DESKTOP_COMMAND_TYPE_SET: ReadonlySet<string> = new Set(DESKTOP_COMMAND_TYPES);
