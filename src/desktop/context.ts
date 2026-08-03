import {
  MAX_THREAD_CONTEXT_CHARS,
  MAX_THREAD_MESSAGE_CHARS,
  type ThreadMessage,
  type ThreadRecordV1,
} from "./types.js";

type ThreadContextSource = readonly ThreadMessage[] | Pick<ThreadRecordV1, "messages">;

function messagesFrom(source: ThreadContextSource): readonly ThreadMessage[] {
  return "messages" in source ? source.messages : source;
}

function currentUserMessage(
  messages: readonly ThreadMessage[],
  currentUserMessageId: string,
): { message: ThreadMessage; index: number } {
  const index = messages.findIndex((message) => message.id === currentUserMessageId);
  if (index < 0) throw new Error("A current user message is required.");
  const message = messages[index];
  if (message.role !== "user") throw new Error("The current message must have role user.");
  if (message.content.trim().length === 0) throw new Error("The current user message is required.");
  if (message.content.length > MAX_THREAD_MESSAGE_CHARS) {
    throw new Error("The current user message must not exceed 20,000 characters.");
  }
  return { message, index };
}

export function buildCurrentTurnContext(
  source: ThreadContextSource,
  currentUserMessageId: string,
  characterBudget = MAX_THREAD_CONTEXT_CHARS,
): ThreadMessage[] {
  if (!Number.isSafeInteger(characterBudget) || characterBudget < 1 || characterBudget > MAX_THREAD_CONTEXT_CHARS) {
    throw new RangeError("The thread context budget must be between 1 and 20,000 characters.");
  }

  const messages = messagesFrom(source);
  const current = currentUserMessage(messages, currentUserMessageId);
  if (current.message.content.length > characterBudget) {
    throw new Error("The current user message exceeds the current-turn context budget.");
  }

  const selected = [current.message];
  let used = current.message.content.length;
  for (let index = current.index - 1; index >= 0; index -= 1) {
    const prior = messages[index];
    if (used + prior.content.length > characterBudget) break;
    selected.push(prior);
    used += prior.content.length;
  }
  return selected;
}

function renderMessage(message: ThreadMessage): string {
  return `[${message.role}]\n${message.content}`;
}

export function buildThreadObjective(
  source: ThreadContextSource,
  currentUserMessageId: string,
  characterBudget = MAX_THREAD_CONTEXT_CHARS,
): string {
  const context = buildCurrentTurnContext(source, currentUserMessageId, characterBudget);
  const current = context[0];
  let objective = renderMessage(current);

  if (objective.length > characterBudget) {
    return current.content;
  }

  for (const prior of context.slice(1)) {
    const addition = `\n\n[prior ${prior.role}]\n${prior.content}`;
    if (objective.length + addition.length > characterBudget) break;
    objective += addition;
  }
  return objective;
}
