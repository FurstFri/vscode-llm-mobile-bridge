import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ProviderAdapter,
  ProviderSessionSnapshot,
  ProviderSessionSummary,
  ProviderTurnEvent,
  TurnOptions,
} from "../gateway/provider-adapter.js";
import type { ProviderLimits, ProviderModel, TimelineItem } from "../gateway/protocol.js";
import { JsonRpcNotification, JsonRpcProcess } from "./json-rpc-client.js";

export type CodexTurnSignal =
  | { kind: "thread"; threadId: string }
  | { kind: "notification"; notification: JsonRpcNotification };

export interface CodexSessionSource {
  listModels(): Promise<unknown>;
  readRateLimits(): Promise<unknown>;
  listThreads(): Promise<unknown>;
  readThread(threadId: string): Promise<unknown>;
  runTurn(threadId: string, text: string, options?: TurnOptions): AsyncIterable<JsonRpcNotification>;
  runNewThread(text: string, options?: TurnOptions, cwd?: string): AsyncIterable<CodexTurnSignal>;
}

export interface CodexReadOnlyAdapterOptions {
  cwd?: string;
  limit?: number;
  allowTurns?: boolean;
  executable?: string;
  /** Working directory for threads created from the phone. */
  defaultCwd?: string;
  source?: CodexSessionSource;
}

export class CodexReadOnlyAdapter implements ProviderAdapter {
  readonly provider = "codex" as const;
  private readonly cwd?: string;
  private readonly limit: number;
  private readonly allowTurns: boolean;
  private readonly defaultCwd?: string;
  private readonly source: CodexSessionSource;
  /** Fetching models spawns an app-server, so keep the answer. */
  private models?: ProviderModel[];

  constructor(options: CodexReadOnlyAdapterOptions = {}) {
    this.cwd = options.cwd;
    this.limit = options.limit ?? 100;
    this.allowTurns = options.allowTurns ?? true;
    this.defaultCwd = options.defaultCwd;
    this.source = options.source ?? new AppServerCodexSource(options.executable, this.limit);
  }

  async listModels(): Promise<readonly ProviderModel[]> {
    if (this.models) return this.models;
    const result = asObject(await this.source.listModels());
    const data = Array.isArray(result?.data) ? result.data : [];
    this.models = data
      .map(asObject)
      .filter((model): model is Record<string, unknown> => Boolean(model) && model?.hidden !== true)
      .flatMap((model) => {
        const id = firstString(model, ["model", "id"]);
        if (!id) return [];
        const efforts = Array.isArray(model.supportedReasoningEfforts)
          ? model.supportedReasoningEfforts
              .map(asObject)
              .map((effort) => (typeof effort?.reasoningEffort === "string" ? effort.reasoningEffort : undefined))
              .filter((effort): effort is string => Boolean(effort))
          : [];
        const description = firstString(model, ["description"]);
        const defaultEffort = firstString(model, ["defaultReasoningEffort"]);
        return [{
          id,
          label: firstString(model, ["displayName"]) ?? id,
          ...(description ? { description } : {}),
          efforts,
          ...(defaultEffort ? { defaultEffort } : {}),
          isDefault: model.isDefault === true,
        }];
      });
    return this.models;
  }

  async readLimits(): Promise<ProviderLimits | undefined> {
    const result = asObject(await this.source.readRateLimits());
    const limits = asObject(result?.rateLimits);
    const primary = asObject(limits?.primary);
    if (!primary && !limits) return undefined;
    const plan = firstString(limits, ["planType"]);
    return {
      ...(typeof primary?.usedPercent === "number" ? { usedPercent: Math.round(primary.usedPercent) } : {}),
      ...(typeof primary?.resetsAt === "number" ? { resetsAt: primary.resetsAt } : {}),
      ...(typeof primary?.windowDurationMins === "number" ? { windowMinutes: primary.windowDurationMins } : {}),
      ...(plan ? { plan } : {}),
      status: limits?.spendControlReached === true || limits?.rateLimitReachedType
        ? "rejected"
        : "allowed",
    };
  }

  async listSessions(): Promise<readonly ProviderSessionSummary[]> {
    const result = asObject(await this.source.listThreads());
    const data = Array.isArray(result?.data) ? result.data : [];
    return data
      .map(asObject)
      .filter((thread): thread is Record<string, unknown> => Boolean(thread))
      .filter((thread) => !this.cwd || typeof thread.cwd !== "string" || samePath(thread.cwd, this.cwd))
      .flatMap((thread) => {
        if (typeof thread.id !== "string") return [];
        return [{
          providerSessionId: thread.id,
          title: firstString(thread, ["name", "preview"]) ?? "Codex conversation",
          project: typeof thread.cwd === "string" && thread.cwd ? projectName(thread.cwd) : undefined,
          updatedAt: typeof thread.updatedAt === "number" ? thread.updatedAt : undefined,
          capabilities: { canRead: true, canStartTurn: this.allowTurns, canApprove: false },
        }];
      });
  }

  async readSnapshot(providerSessionId: string): Promise<ProviderSessionSnapshot> {
    const result = asObject(await this.source.readThread(providerSessionId));
    const thread = asObject(result?.thread);
    if (!thread) throw new Error("Codex thread/read returned no thread");
    const turns = Array.isArray(thread.turns) ? thread.turns.map(asObject).filter(Boolean) : [];
    const items = turns.flatMap((turn) => Array.isArray(turn?.items) ? normalizeCodexItems(turn.items) : []);
    const lastTurn = turns.at(-1);
    const lastItems = Array.isArray(lastTurn?.items) ? lastTurn.items : [];
    const lastItem = asObject(lastItems.at(-1));
    const status = asObject(thread.status)?.type ?? thread.status;
    return {
      revision: `${numberOrZero(thread.updatedAt)}:${stringOrEmpty(lastTurn?.id)}:${stringOrEmpty(lastItem?.id)}`,
      state: status === "active" || status === "running" ? "busy" : "idle",
      items,
    };
  }

  async *startTurn(providerSessionId: string, text: string, options?: TurnOptions): AsyncIterable<ProviderTurnEvent> {
    if (!this.allowTurns) throw new Error("Sending messages to Codex threads is disabled in settings.");
    for await (const notification of this.source.runTurn(providerSessionId, text, options)) {
      yield* mapCodexNotification(notification);
    }
  }

  async *startNewSession(text: string, options?: TurnOptions): AsyncIterable<ProviderTurnEvent> {
    if (!this.allowTurns) throw new Error("Sending messages to Codex threads is disabled in settings.");
    const cwd = this.defaultCwd ?? this.cwd;
    for await (const signal of this.source.runNewThread(text, options, cwd)) {
      if (signal.kind === "thread") {
        yield {
          type: "session.new",
          payload: {
            providerSessionId: signal.threadId,
            title: text.trim().slice(0, 60),
            project: cwd ? projectName(cwd) : undefined,
            updatedAt: Date.now(),
          },
        };
      } else {
        yield* mapCodexNotification(signal.notification);
      }
    }
  }
}

function* mapCodexNotification(notification: JsonRpcNotification): Generator<ProviderTurnEvent> {
  const params = asObject(notification.params);
  if (notification.method === "turn/completed") {
    const status = firstString(asObject(params?.turn), ["status"]) ?? "completed";
    yield {
      type: "turn.status",
      payload: { status: status === "completed" ? "completed" : "failed" },
    };
    return;
  }
  const item = asObject(params?.item);
  if (!item) return;
  for (const normalized of normalizeCodexItems([item])) {
    yield { type: "item.complete", payload: { item: normalized } };
  }
}

class AppServerCodexSource implements CodexSessionSource {
  constructor(private readonly configuredExecutable?: string, private readonly limit = 100) {}

  async listModels(): Promise<unknown> {
    return this.request("model/list", {});
  }

  async readRateLimits(): Promise<unknown> {
    return this.request("account/rateLimits/read", {});
  }

  async listThreads(): Promise<unknown> {
    return this.request("thread/list", { limit: this.limit });
  }

  async readThread(threadId: string): Promise<unknown> {
    return this.request("thread/read", { threadId, includeTurns: true });
  }

  async *runTurn(threadId: string, text: string, options?: TurnOptions): AsyncIterable<JsonRpcNotification> {
    const appServer = await this.startAppServer();
    try {
      const resumed = await appServer.request("thread/resume", { threadId }, 30_000);
      if (resumed.error) throw new Error(resumed.error.message ?? "Codex thread/resume failed");
      yield* this.streamTurn(appServer, threadId, text, options);
    } finally {
      appServer.close();
    }
  }

  async *runNewThread(text: string, options?: TurnOptions, cwd?: string): AsyncIterable<CodexTurnSignal> {
    const appServer = await this.startAppServer();
    try {
      const started = await appServer.request("thread/start", cwd ? { cwd } : {}, 30_000);
      if (started.error) throw new Error(started.error.message ?? "Codex thread/start failed");
      const thread = asObject(asObject(started.result)?.thread);
      const threadId = typeof thread?.id === "string" ? thread.id : undefined;
      if (!threadId) throw new Error("Codex thread/start returned no thread id");
      yield { kind: "thread", threadId };
      for await (const notification of this.streamTurn(appServer, threadId, text, options)) {
        yield { kind: "notification", notification };
      }
    } finally {
      appServer.close();
    }
  }

  private async *streamTurn(
    appServer: JsonRpcProcess,
    threadId: string,
    text: string,
    options?: TurnOptions,
  ): AsyncIterable<JsonRpcNotification> {
    const queue: JsonRpcNotification[] = [];
    let wake: (() => void) | undefined;
    const unsubscribe = appServer.onNotification((notification) => {
      queue.push(notification);
      wake?.();
    });
    try {
      const started = await appServer.request("turn/start", {
        threadId,
        input: [{ type: "text", text }],
        ...(options?.model ? { model: options.model } : {}),
        ...(options?.effort ? { effort: options.effort } : {}),
      }, 60_000);
      if (started.error) throw new Error(started.error.message ?? "Codex turn/start failed");

      const deadline = Date.now() + 10 * 60_000;
      let finished = false;
      while (!finished) {
        while (queue.length === 0) {
          if (Date.now() > deadline) throw new Error("Timed out waiting for the Codex turn to complete");
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, 1_000);
          });
          wake = undefined;
        }
        const notification = queue.shift();
        if (!notification) continue;
        yield notification;
        if (notification.method === "turn/completed" || notification.method === "turn/failed") finished = true;
      }
    } finally {
      unsubscribe();
    }
  }

  private async startAppServer(): Promise<JsonRpcProcess> {
    const appServer = await JsonRpcProcess.start(resolveCodexExecutable(this.configuredExecutable), ["app-server", "--stdio"]);
    try {
      const initialized = await appServer.request("initialize", {
        clientInfo: { name: "vscode-llm-mobile-bridge", title: "LLM Mobile Bridge", version: "0.1.0" },
      });
      if (initialized.error) throw new Error(initialized.error.message ?? "Codex initialize failed");
      appServer.notify("initialized", {});
      return appServer;
    } catch (error) {
      appServer.close();
      throw error;
    }
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const appServer = await this.startAppServer();
    try {
      const response = await appServer.request(method, params, 30_000);
      if (response.error) throw new Error(response.error.message ?? `${method} failed`);
      return response.result;
    } finally {
      appServer.close();
    }
  }
}

export function normalizeCodexItems(values: readonly unknown[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const item = asObject(values[index]);
    if (!item || typeof item.type !== "string") continue;
    const id = typeof item.id === "string" ? item.id : `codex-item-${index}`;
    const at = extractItemTimestamp(item);
    const stamp = at !== undefined ? { at } : {};
    if (item.type === "userMessage") {
      items.push({ id, kind: "message", role: "user", text: extractText(item.content), status: "completed", ...stamp });
    } else if (item.type === "agentMessage") {
      items.push({ id, kind: "message", role: "assistant", text: stringOrEmpty(item.text), status: "completed", ...stamp });
    } else if (item.type === "reasoning") {
      const summary = extractText(item.summary);
      const content = extractText(item.content);
      items.push({ id, kind: "reasoning", text: summary || content || "Reasoning", status: "completed", ...stamp });
    } else {
      const label = firstString(item, ["name", "tool", "command", "query", "review", "result"]) ?? humanize(item.type);
      const output = firstString(item, ["aggregatedOutput", "output"]);
      items.push({
        id,
        kind: "tool",
        text: output ? `${label}\n${output}` : label,
        status: normalizeStatus(item.status),
        ...stamp,
      });
    }
  }
  return items.filter((item) => item.text?.trim().length);
}

function extractItemTimestamp(item: Record<string, unknown>): number | undefined {
  for (const key of ["completedAt", "updatedAt", "createdAt", "timestamp", "startedAt"]) {
    const raw = item[key];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string") {
      const parsed = Date.parse(raw);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return undefined;
}

function resolveCodexExecutable(configured?: string): string {
  if (configured) return configured;
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  const extensionRoot = join(homedir(), ".vscode", "extensions");
  if (existsSync(extensionRoot)) {
    const candidates = readdirSync(extensionRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("openai.chatgpt-"))
      .map((entry) => join(extensionRoot, entry.name, "bin", "windows-x86_64", "codex.exe"))
      .filter(existsSync)
      .sort();
    const latest = candidates.at(-1);
    if (latest) return latest;
  }
  return "codex";
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (typeof part === "string") return part;
    const record = asObject(part);
    return firstString(record, ["text", "content", "summary"]) ?? "";
  }).filter(Boolean).join("\n");
}

function normalizeStatus(value: unknown): TimelineItem["status"] {
  const status = typeof value === "string" ? value : asObject(value)?.type;
  if (status === "completed" || status === "success") return "completed";
  if (status === "failed" || status === "error" || status === "declined") return "failed";
  if (status === "inProgress" || status === "running") return "running";
  return "completed";
}

function firstString(value: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  for (const key of keys) if (typeof value?.[key] === "string" && value[key]) return value[key] as string;
  return undefined;
}

function humanize(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

function projectName(cwd: string): string | undefined {
  return cwd.split(/[\\/]/).filter(Boolean).at(-1);
}

function samePath(left: string, right: string): boolean {
  return left.replaceAll("/", "\\").toLowerCase() === right.replaceAll("/", "\\").toLowerCase();
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}
