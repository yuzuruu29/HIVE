"use client";

import { useEffect, useRef, useState, type DragEvent, type RefObject } from "react";
import {
  ArrowUp,
  ArrowCounterClockwise,
  CaretRight,
  Copy,
  CrownSimple,
  FileText,
  Globe,
  NotePencil,
  Paperclip,
  Repeat,
  Stop,
  X,
} from "@phosphor-icons/react";
import { chatModeDetails } from "./chat-mode-config";
import { useHiveAnimatedPlaceholder } from "./hive-animated-placeholder";
import { MarkdownMessage } from "./markdown-message";
import { BranchNavigator } from "./branch-navigator";
import {
  HiveThinkingBlock,
  safeProcessingErrorLabel,
  type HiveExecutionSummary,
  type HiveProcessingStatus,
  type HiveProcessingStep,
} from "./hive-thinking-block";
import { ModelPicker } from "./model-picker";
import type { HiveModelCatalogEntry } from "@hive-cloud/contracts";
import { useCopyFeedback } from "../lib/copy-feedback";
import { ATTEMPT_REASON_LABELS } from "../lib/processing-stages";

export type ChatMode = "chat" | "build" | "research";

export type { ProcessingAnimation } from "@/lib/processing-stages";

export type ProcessingStage = HiveProcessingStatus;

function sourceHost(url: string): string {
  try { return new URL(url).hostname; } catch { return "Source"; }
}

export interface ChatRouteAttempt {
  provider: string;
  model: string;
  status: "selected" | "failed" | "skipped";
  statusCode?: number;
  reason?: string;
  latencyMs: number;
}

export interface ChatRouteReceipt {
  requestId: string;
  provider: string;
  model: string;
  policy: string;
  fallbackCount: number;
  router?: string;
  managed?: boolean;
  costClass?: "free" | "paid" | "byok";
  latencyMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  attempts?: ChatRouteAttempt[];
  executionSummary?: HiveExecutionSummary;
}

export interface ChatMessageProcessing {
  status: ProcessingStage;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  searchActive?: boolean;
  citationCount?: number;
  preparedFileCount?: number;
  errorCode?: string;
  searchErrorCode?: string;
}

export interface ChatMessageData {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  status: string;
  routeReceipt?: ChatRouteReceipt;
  processingStage?: ProcessingStage;
  processing?: ChatMessageProcessing;
  progress?: number;
  createdAt?: string;
  parentMessageId?: string | null;
  revision?: number;
  attachments?: { id: string; name: string; status: string; mimeType?: string; sizeBytes?: number }[];
  citations?: { title: string; url: string; retrievedAt: string }[];
}

export interface ComposerAttachment {
  id: string;
  name: string;
  kind: "text" | "image";
}

export function HiveCoreMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="hive-core-mark" data-compact={compact} aria-hidden="true">
      <span className="hive-core-orbit"><i /><i /><i /><i /><i /></span>
      <span className="hive-core-cell"><CrownSimple size={compact ? 20 : 27} weight="fill" /></span>
    </div>
  );
}

export function PromptComposer({
  value,
  onChange,
  mode,
  search,
  onSearchChange,
  attachments,
  attachmentStatus,
  streaming,
  online,
  animatePlaceholder = false,
  inputRef,
  onFiles,
  onRemoveAttachment,
  onSubmit,
  onStop,
  models,
  selectedModelId,
  onModelChange,
  modelsLoading,
  modelsError,
  onRefreshModels,
}: {
  value: string;
  onChange: (value: string) => void;
  mode: ChatMode;
  search: boolean;
  onSearchChange: (active: boolean) => void;
  attachments: ComposerAttachment[];
  attachmentStatus?: string;
  streaming: boolean;
  online: boolean;
  animatePlaceholder?: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onFiles: (files: File[]) => Promise<void>;
  onRemoveAttachment: (index: number) => void;
  onSubmit: () => void;
  onStop: () => void;
  models?: HiveModelCatalogEntry[];
  selectedModelId?: string;
  onModelChange?: (id: string) => void;
  modelsLoading?: boolean;
  modelsError?: boolean;
  onRefreshModels?: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const allowsFiles = mode !== "build";

  useEffect(() => {
    if (!inputRef.current) return;
    inputRef.current.style.height = "auto";
    inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 180)}px`;
  }, [inputRef, value]);

  async function acceptFiles(files: File[]) {
    if (!allowsFiles || files.length === 0) return;
    await onFiles(files);
  }

  function dropFiles(event: DragEvent<HTMLFormElement>) {
    event.preventDefault();
    setDragging(false);
    void acceptFiles([...event.dataTransfer.files]);
  }

  const fallbackPlaceholder = online ? chatModeDetails[mode].placeholder : "Reconnect to send a message";
  const placeholder = useHiveAnimatedPlaceholder({ enabled: online && animatePlaceholder && value.length === 0, fallback: fallbackPlaceholder });
  const submitLabel = mode === "build" ? "Open the Queen Council" : "Send message";

  return (
    <form
      className="composer"
      data-dragging={dragging}
      data-mode={mode}
      onSubmit={(event) => { event.preventDefault(); onSubmit(); }}
      onDragEnter={(event) => { event.preventDefault(); if (allowsFiles) setDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={dropFiles}
    >
      <div className="composer-drop-state" aria-hidden={!dragging}><Paperclip size={18} /> Drop files into the Hive</div>
      <textarea
        ref={inputRef}
        rows={1}
        aria-label="Message HIVE"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSubmit();
          }
        }}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (files.length > 0) {
            event.preventDefault();
            void acceptFiles(files);
          }
        }}
      />
      {(attachments.length > 0 || attachmentStatus) && <div className="attachment-list" aria-live="polite">
        {attachments.map((file, index) => <span className="attachment-chip" key={`${file.name}-${index}`}><FileText size={13} /><span>{file.name}</span><button type="button" aria-label={`Remove ${file.name}`} onClick={() => onRemoveAttachment(index)}><X size={12} /></button></span>)}
        {attachmentStatus && <span className="attachment-progress"><i aria-hidden="true" />{attachmentStatus}</span>}
      </div>}
      <div className="composer-bar">
        <div className="composer-tools">
          {allowsFiles && <>
            <input ref={fileInput} type="file" multiple hidden accept="image/png,image/jpeg,image/webp,application/pdf,text/plain,text/markdown,text/csv,application/json,.ts,.tsx,.js,.jsx,.py,.rs,.go,.java,.cs,.css,.html" onChange={(event) => { void acceptFiles([...(event.target.files || [])]); event.target.value = ""; }} />
            <button className="tool-toggle" type="button" aria-label="Attach files" onClick={() => fileInput.current?.click()}><Paperclip size={16} /><span>Files</span></button>
          </>}
          {mode !== "build" && <button className="tool-toggle" type="button" aria-pressed={search} data-active={search} onClick={() => onSearchChange(!search)}><Globe size={16} /><span>Search</span></button>}
        </div>
        <div className="composer-actions-right">
          {mode === "build" ? (
            <div className="composer-route">
              <CrownSimple size={13} weight="fill" />
              <span>Queen Council</span>
              <small>7 routed calls</small>
            </div>
          ) : (
            <ModelPicker
              models={models || []}
              selectedId={selectedModelId || "hive-0.1"}
              onChange={(id) => onModelChange?.(id)}
              disabled={!online || streaming}
              loading={modelsLoading}
              error={modelsError}
              onRefresh={onRefreshModels}
            />
          )}
          {streaming ? <button className="button button-secondary composer-submit" type="button" onClick={onStop}><Stop size={15} weight="fill" /><span>Stop</span></button> : <button className="button button-primary composer-submit" type="submit" disabled={!online || !value.trim()} aria-label={submitLabel}><ArrowUp size={17} weight="bold" /><span>{mode === "build" ? "Run" : "Send"}</span></button>}
        </div>
      </div>
      <div className="composer-hint"><span>{mode === "build" ? "Files are added before the Council starts" : search ? "Cited search is on" : "Provider selected after send"}</span><span><kbd>/</kbd> focus <kbd>Enter</kbd> send</span></div>
    </form>
  );
}

function receiptSummary(receipt: ChatRouteReceipt): string {
  const latency = receipt.latencyMs === undefined ? "Pending" : receipt.latencyMs >= 1_000 ? `${(receipt.latencyMs / 1_000).toFixed(1)}s` : `${receipt.latencyMs}ms`;
  return `${receipt.provider} ${receipt.model} · ${latency} · ${receipt.fallbackCount} fallback${receipt.fallbackCount === 1 ? "" : "s"}`;
}

export function processingStatus(message: ChatMessageData): HiveProcessingStatus {
  if (message.processing?.status) return message.processing.status;
  if (message.routeReceipt?.executionSummary?.status) return message.routeReceipt.executionSummary.status;
  if (message.status === "cancelled") return "cancelled";
  if (message.status === "failed") return "failed";
  if (message.status === "complete") return "completed";
  return message.processingStage || "routing";
}

export function processingLabel(message: ChatMessageData, status: HiveProcessingStatus): string {
  const summary = message.processing || message.routeReceipt?.executionSummary;
  switch (status) {
    case "queued": return "Queen received your request";
    case "routing": return "HIVE is selecting an eligible route";
    case "searching": return "Searching cited sources";
    case "reading-files": return "Preparing attached files";
    case "reasoning": return "Comparing retrieved evidence";
    case "waiting-first-token": return message.routeReceipt?.model ? `Waiting for ${message.routeReceipt.model}` : "Waiting for the provider";
    case "streaming": return "HIVE is responding";
    case "retrying": return "Retrying before response output began";
    case "cancelled": return "Request cancelled";
    case "failed": return safeProcessingErrorLabel(summary?.errorCode);
    case "completed":
      if ((summary?.citationCount || 0) > 0) return "Source-backed response prepared";
      return message.routeReceipt?.model ? `Response prepared with ${message.routeReceipt.model}` : "Response complete";
  }
}

export function buildProcessingSteps(message: ChatMessageData, status: HiveProcessingStatus): HiveProcessingStep[] {
  const receipt = message.routeReceipt;
  const summary = message.processing || receipt?.executionSummary;
  const terminal = status === "completed" || status === "cancelled" || status === "failed";
  const steps: HiveProcessingStep[] = [{
    id: "received",
    label: "Request received",
    status: "completed",
  }, {
    id: "interpreted",
    label: "Interpreted the request",
    status: status === "queued" ? "active" : "completed",
  }];

  if ((summary?.preparedFileCount || 0) > 0) steps.push({
    id: "files",
    label: `Prepared ${summary!.preparedFileCount} attached file${summary!.preparedFileCount === 1 ? "" : "s"}`,
    status: "completed",
    detail: "Included only after local file preparation completed",
  });

  if (summary?.searchActive) steps.push({
    id: "search",
    label: status === "searching" ? "Retrieving cited sources" : (summary.citationCount || 0) > 0 ? `Retrieved ${summary.citationCount} cited source${summary.citationCount === 1 ? "" : "s"}` : "Search completed without cited sources",
    status: status === "searching" ? "active" : message.processing?.searchErrorCode ? "warning" : "completed",
    detail: message.processing?.searchErrorCode ? "Search was unavailable; the request continued without source claims" : undefined,
  });

  const routeAvailable = Boolean(receipt && receipt.provider !== "unknown" && receipt.provider !== "unavailable");
  if (status === "failed" && summary?.errorCode === "unsupported_capability") {
    steps.push({
      id: "route",
      label: "No eligible model route was found",
      status: "failed",
    });
  } else {
    steps.push({
      id: "route",
      label: routeAvailable ? "Selected an eligible model route" : "Selecting an eligible model route",
      status: routeAvailable ? "completed" : status === "routing" || status === "retrying" ? "active" : status === "failed" ? "failed" : status === "cancelled" ? "cancelled" : "pending",
      provider: routeAvailable ? receipt?.provider : undefined,
      model: routeAvailable ? receipt?.model : undefined,
    });
  }

  if (receipt?.attempts?.length) receipt.attempts.forEach((attempt, index) => {
    if (receipt.attempts!.length === 1 && attempt.status === "selected") return;
    steps.push({
      id: `attempt-${index}`,
      label: `Attempt ${index + 1} · ${attempt.status === "selected" ? "completed" : attempt.status}`,
      status: attempt.status === "selected" ? "completed" : "warning",
      provider: attempt.provider,
      model: attempt.model,
      durationMs: attempt.latencyMs,
      detail: attempt.reason ? ATTEMPT_REASON_LABELS[attempt.reason] || "Provider attempt did not complete" : undefined,
    });
  });

  if (!(status === "failed" && summary?.errorCode === "unsupported_capability")) {
    steps.push({
      id: "first-token",
      label: status === "waiting-first-token" ? "Waiting for the first response token" : "First response token received",
      status: status === "waiting-first-token" ? "active" : status === "streaming" || status === "completed" ? "completed" : terminal ? (status === "failed" ? "failed" : "cancelled") : "pending",
    });
    steps.push({
      id: "response",
      label: status === "completed" ? "Response completed" : status === "failed" ? safeProcessingErrorLabel(summary?.errorCode) : status === "cancelled" ? "Response cancelled" : "Preparing the response",
      status: status === "streaming" ? "active" : status === "completed" ? "completed" : status === "failed" ? "failed" : status === "cancelled" ? "cancelled" : "pending",
    });
  }
  return steps;
}

export function RouteReceiptChip({ receipt, onOpen }: { receipt: ChatRouteReceipt; onOpen: () => void }) {
  return <button className="route-receipt-inline" type="button" onClick={onOpen}><CrownSimple size={14} weight="fill" /><span>{receiptSummary(receipt)}</span><CaretRight size={14} /></button>;
}

export function ChatMessage({
  message,
  latest,
  streaming,
  lastUser,
  onEdit,
  onRegenerate,
  onRetry,
  onReceipt,
  onCancel,
  currentRevision,
  totalRevisions,
  onNavigateRevision,
}: {
  message: ChatMessageData;
  latest: boolean;
  streaming: boolean;
  lastUser?: string;
  onEdit: (content: string) => void;
  onRegenerate: () => void;
  onRetry?: (messageId: string) => void;
  onReceipt: (receipt: ChatRouteReceipt) => void;
  onCancel?: () => void;
  currentRevision?: number;
  totalRevisions?: number;
  onNavigateRevision?: (index: number) => void;
}) {
  const { copy, status: copyStatus } = useCopyFeedback();
  const status = processingStatus(message);
  const summary = message.processing || message.routeReceipt?.executionSummary;
  const showProcessing = message.role === "assistant" && (message.status === "streaming" || message.status === "failed" || message.status === "cancelled" || Boolean(message.routeReceipt));
  const routeSummary = status === "failed" && summary?.errorCode === "unsupported_capability"
    ? <span className="route-fallback-title" style={{ display: "inline-flex", flexDirection: "column", gap: "2px" }}>
        <span>No route selected</span>
        <span style={{ fontSize: "0.9em", opacity: 0.8 }}>Review provider configuration</span>
      </span>
    : message.routeReceipt && message.routeReceipt.provider !== "unknown" && message.routeReceipt.provider !== "unavailable"
      ? `${message.routeReceipt.provider} · ${message.routeReceipt.model} · ${message.routeReceipt.policy} · ${message.routeReceipt.fallbackCount} fallback${message.routeReceipt.fallbackCount === 1 ? "" : "s"}`
      : undefined;
  return (
    <article className="message" data-role={message.role} data-status={message.status} data-message-id={message.id}>
      <div className="message-head">{message.role === "assistant" ? <div className="assistant-identity"><span className="queen-avatar" aria-hidden="true"><CrownSimple size={14} weight="fill" /></span><div><strong>HIVE 0.1</strong><span>{message.status === "streaming" ? "Routing response" : message.status === "failed" ? "Route failed" : message.status === "cancelled" ? "Request cancelled" : "Response complete"}</span></div></div> : <div className="user-identity"><strong>You</strong></div>}{message.status === "streaming" && message.content.length > 0 && <span className="streaming-state"><i aria-hidden="true" /> live</span>}</div>
      <div className="message-body">{message.role === "assistant" ? <>
        {showProcessing ? <HiveThinkingBlock
          status={status}
          label={processingLabel(message, status)}
          steps={buildProcessingSteps(message, status)}
          startedAt={summary?.startedAt}
          completedAt={summary?.completedAt}
          elapsedMs={summary?.durationMs}
          defaultExpanded={Boolean(summary?.searchActive) || status === "failed"}
          requestId={message.routeReceipt?.requestId}
          routeSummary={routeSummary}
          onOpenRoute={message.routeReceipt && routeSummary ? () => onReceipt(message.routeReceipt!) : undefined}
          onCancel={latest && streaming ? onCancel : undefined}
        /> : null}
        {message.content && <div className="assistant-response-content"><MarkdownMessage content={message.content} /></div>}
        {message.citations && message.citations.length > 0 && <section className="source-group" aria-label="Sources"><div className="source-group-head"><strong>Sources</strong><span>{message.citations.length} retrieved</span></div><div>{message.citations.map((citation) => <a className="source-link" href={citation.url} target="_blank" rel="noreferrer" key={`${citation.url}-${citation.retrievedAt}`}><span>{citation.title}</span><small>{sourceHost(citation.url)}</small></a>)}</div></section>}
      </> : <>
        {message.attachments && message.attachments.length > 0 && (
          <div className="message-attachments" style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "8px" }}>
            {message.attachments.map((att) => (
              <a key={att.id} href={`/api/files/${att.id}/download`} target="_blank" rel="noreferrer" className="attachment-chip" style={{ display: "inline-flex", alignItems: "center", gap: "6px", textDecoration: "none", color: "inherit", padding: "4px 8px", background: "rgba(0,0,0,0.05)", borderRadius: "6px", fontSize: "0.85em" }}>
                <FileText size={14} />
                <span>{att.name}</span>
                {att.status === "scanning" && <span style={{ opacity: 0.5 }}>(scanning)</span>}
              </a>
            ))}
          </div>
        )}
        <p>{message.content}</p>
      </>}</div>
      <div className="message-tools">
        {totalRevisions !== undefined && totalRevisions > 1 && onNavigateRevision && (
          <BranchNavigator
            current={currentRevision || 1}
            total={totalRevisions}
            onPrevious={() => onNavigateRevision((currentRevision || 1) - 2)}
            onNext={() => onNavigateRevision(currentRevision || 1)}
          />
        )}
        <button className="message-tool" type="button" onClick={() => void copy(message.content)}><Copy size={14} /> {copyStatus === "copied" ? "Copied" : copyStatus === "failed" ? "Copy failed" : "Copy"}</button>
        <span className="sr-only" aria-live="polite">{copyStatus === "copied" ? "Message copied to clipboard" : copyStatus === "failed" ? "Message could not be copied" : ""}</span>
        {message.role === "user" && <button className="message-tool" type="button" onClick={() => onEdit(message.content)}><NotePencil size={14} /> Edit</button>}
        {message.role === "assistant" && latest && lastUser && <button className="message-tool" type="button" disabled={streaming} onClick={onRegenerate}><Repeat size={14} /> Regenerate</button>}
        {message.role === "assistant" && (message.status === "failed" || message.status === "cancelled") && onRetry && <button className="message-tool" type="button" disabled={streaming} onClick={() => onRetry(message.id)}><ArrowCounterClockwise size={14} /> Retry</button>}
      </div>
    </article>
  );
}
