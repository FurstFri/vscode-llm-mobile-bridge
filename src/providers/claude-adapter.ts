import { randomUUID } from "node:crypto";
import {
  getSessionInfo,
  getSessionMessages,
  listSessions,
  query,
  type GetSessionInfoOptions,
  type GetSessionMessagesOptions,
  type HookCallback,
  type ListSessionsOptions,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type PreToolUseHookInput,
  type SDKMessage,
  type SDKSessionInfo,
  type SessionMessage,
  type SyncHookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import { EventChannel } from "./event-channel.js";
import { resolveClaudeExecutable } from "./executables.js";
import type {
  ProviderAdapter,
  ProviderSessionSnapshot,
  ProviderSessionSummary,
  ProviderTurnEvent,
  TurnOptions,
} from "../gateway/provider-adapter.js";
import type { ProviderLimits, ProviderModel, TimelineItem } from "../gateway/protocol.js";

/** Shape of the SDK's ModelInfo we rely on; extra fields are ignored. */
export interface ClaudeModelInfo {
  value: string;
  displayName?: string;
  description?: string;
  supportedEffortLevels?: string[];
}

export interface ClaudeSessionSource {
  listSessions(options?: ListSessionsOptions): Promise<SDKSessionInfo[]>;
  getSessionInfo(sessionId: string, options?: GetSessionInfoOptions): Promise<SDKSessionInfo | undefined>;
  getSessionMessages(sessionId: string, options?: GetSessionMessagesOptions): Promise<SessionMessage[]>;
  runQuery(params: { prompt: string; options?: Options }): AsyncIterable<SDKMessage>;
  listModels(options?: Options): Promise<ClaudeModelInfo[]>;
}

/**
 * `askOnPhone` keeps the project's permission rules but forwards every
 * prompt to the phone instead of deadlocking on a terminal that nobody
 * is watching.
 */
export type ClaudePermissionMode = "askOnPhone" | "default" | "acceptEdits" | "bypassPermissions";

export interface ClaudeReadOnlyAdapterOptions {
  dir?: string;
  limit?: number;
  allowTurns?: boolean;
  permissionMode?: ClaudePermissionMode;
  /** Explicit path to the claude executable; auto-resolved when omitted. */
  executablePath?: string;
  /** Working directory for sessions created from the phone. */
  defaultCwd?: string;
  source?: ClaudeSessionSource;
}

/** A prompt nobody answers must not hold the turn open indefinitely. */
const APPROVAL_TIMEOUT_MS = 5 * 60_000;

const sdkSource: ClaudeSessionSource = {
  listSessions,
  getSessionInfo,
  getSessionMessages,
  runQuery: (params) => query(params),
  listModels: async (options) => {
    // Streaming-input mode with an idle prompt: the CLI starts and answers
    // control requests, but no turn is ever submitted.
    const session = query({ prompt: idlePrompt(), options });
    try {
      return await withTimeout(session.supportedModels(), 20_000) as ClaudeModelInfo[];
    } finally {
      await session.return(undefined).catch(() => undefined);
    }
  },
};

async function* idlePrompt(): AsyncGenerator<never> {
  await new Promise<never>(() => {});
  throw new Error("unreachable");
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out listing Claude models")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); },
    );
  });
}

export class ClaudeReadOnlyAdapter implements ProviderAdapter {
  readonly provider = "claude" as const;
  private readonly dir?: string;
  private readonly limit: number;
  private readonly allowTurns: boolean;
  private readonly permissionMode: ClaudePermissionMode;
  private readonly source: ClaudeSessionSource;
  private readonly configuredExecutable?: string;
  private readonly defaultCwd?: string;
  private resolvedExecutable?: string | null;
  /** Model list is stable for the CLI's lifetime; fetching it spawns a process. */
  private models?: ProviderModel[];
  /** Claude reports usage as a stream event, so keep the newest one seen. */
  private limits?: ProviderLimits;
  private readonly pendingApprovals = new Map<string, (allow: boolean, message?: string) => void>();

  constructor(options: ClaudeReadOnlyAdapterOptions = {}) {
    this.dir = options.dir;
    this.limit = options.limit ?? 100;
    this.allowTurns = options.allowTurns ?? true;
    this.permissionMode = options.permissionMode ?? "default";
    this.configuredExecutable = options.executablePath;
    this.defaultCwd = options.defaultCwd;
    this.source = options.source ?? sdkSource;
  }

  async listModels(): Promise<readonly ProviderModel[]> {
    if (this.models) return this.models;
    const infos = await this.source.listModels(this.baseQueryOptions());
    this.models = infos.map((info) => ({
      id: info.value,
      label: info.displayName ?? info.value,
      ...(info.description ? { description: info.description } : {}),
      efforts: info.supportedEffortLevels ?? [],
      isDefault: info.value === "default",
    }));
    return this.models;
  }

  async readLimits(): Promise<ProviderLimits | undefined> {
    // The CLI only reports usage while a turn streams, so this stays empty
    // until the first message is sent from the phone or seen from VS Code.
    return this.limits ?? { note: "Появится после первого ответа" };
  }

  async listSessions(): Promise<readonly ProviderSessionSummary[]> {
    const sessions = await this.source.listSessions({
      ...(this.dir ? { dir: this.dir } : {}),
      limit: this.limit,
    });
    return sessions.map((session) => ({
      providerSessionId: session.sessionId,
      title: session.customTitle ?? session.summary,
      project: session.cwd ? projectName(session.cwd) : undefined,
      updatedAt: session.lastModified,
      capabilities: {
        canRead: true,
        canStartTurn: this.allowTurns,
        canApprove: false,
      },
    }));
  }

  async readSnapshot(providerSessionId: string): Promise<ProviderSessionSnapshot> {
    const lookupOptions = this.dir ? { dir: this.dir } : undefined;
    const [info, messages] = await Promise.all([
      this.source.getSessionInfo(providerSessionId, lookupOptions),
      this.source.getSessionMessages(providerSessionId, lookupOptions),
    ]);
    const lastMessageId = messages.at(-1)?.uuid ?? "empty";
    return {
      revision: `${info?.lastModified ?? 0}:${info?.fileSize ?? 0}:${lastMessageId}`,
      state: "idle",
      items: normalizeClaudeMessages(messages),
    };
  }

  async *startTurn(providerSessionId: string, text: string, options?: TurnOptions): AsyncIterable<ProviderTurnEvent> {
    if (!this.allowTurns) throw new Error("Sending messages to Claude sessions is disabled in settings.");
    const info = await this.source.getSessionInfo(
      providerSessionId,
      this.dir ? { dir: this.dir } : undefined,
    );
    yield* this.runTurn({
      resume: providerSessionId,
      ...(info?.cwd ? { cwd: info.cwd } : {}),
      ...this.baseQueryOptions(options),
    }, text);
  }

  /** Runs a query, merging its stream with approval prompts it triggers. */
  private async *runTurn(
    queryOptions: Options,
    text: string,
    onMessage?: (message: SDKMessage) => ProviderTurnEvent[],
  ): AsyncIterable<ProviderTurnEvent> {
    const channel = new EventChannel<ProviderTurnEvent>();
    const usePhonePermissions = this.permissionMode === "askOnPhone";
    const stream = this.source.runQuery({
      prompt: text,
      options: {
        ...queryOptions,
        // canUseTool covers permission checks; AskUserQuestion bypasses that
        // and needs a PreToolUse hook to reach us before the SDK invokes it.
        ...(usePhonePermissions ? { canUseTool: this.askPhone(channel) } : {}),
        hooks: {
          ...(queryOptions.hooks ?? {}),
          PreToolUse: [
            ...(queryOptions.hooks?.PreToolUse ?? []),
            { matcher: "AskUserQuestion", hooks: [this.askUserQuestionHook(channel)] },
          ],
        },
      },
    });

    void (async () => {
      try {
        for await (const message of stream) {
          this.captureRateLimit(message);
          for (const event of onMessage?.(message) ?? mapClaudeStreamMessage(message)) channel.push(event);
        }
        channel.close();
      } catch (error) {
        channel.fail(error);
      }
    })();

    yield* channel;
  }

  async *startNewSession(text: string, options?: TurnOptions): AsyncIterable<ProviderTurnEvent> {
    if (!this.allowTurns) throw new Error("Sending messages to Claude sessions is disabled in settings.");
    const cwd = this.defaultCwd ?? this.dir;
    let announced = false;
    yield* this.runTurn(
      { ...(cwd ? { cwd } : {}), ...this.baseQueryOptions(options) },
      text,
      (message) => {
        const record = message as unknown as Record<string, unknown>;
        const events: ProviderTurnEvent[] = [];
        if (!announced && typeof record.session_id === "string" && record.session_id) {
          announced = true;
          events.push({
            type: "session.new",
            payload: {
              providerSessionId: record.session_id,
              title: text.trim().slice(0, 60),
              project: cwd ? projectName(cwd) : undefined,
              updatedAt: Date.now(),
            },
          });
        }
        events.push(...mapClaudeStreamMessage(message));
        return events;
      },
    );
  }

  private baseQueryOptions(turn?: TurnOptions): Partial<Options> {
    const executable = this.claudeExecutable();
    const extra: Record<string, unknown> = {};
    // The phone can pick the edit mode for this turn, mirroring the panel.
    if (turn?.mode) extra.permissionMode = turn.mode;
    if (turn?.model) extra.model = turn.model;
    if (turn?.effort === "off") {
      extra.thinking = { type: "disabled" };
    } else if (turn?.effort) {
      extra.effort = turn.effort;
      extra.thinking = { type: "adaptive" };
    }
    return {
      // askOnPhone keeps the project's rules and routes prompts to the phone.
      permissionMode: this.permissionMode === "askOnPhone" ? "default" : this.permissionMode,
      // The bundled extension has no node_modules, so the SDK cannot find
      // its optional native binary — point it at the installed CLI.
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
      ...(extra as Partial<Options>),
    };
  }

  /** Answers a pending approval or question; false when nothing was waiting. */
  resolveApproval(id: string, allow: boolean, message?: string, choice?: string): boolean {
    const pending = this.pendingApprovals.get(id);
    if (!pending) return false;
    this.pendingApprovals.delete(id);
    pending(allow, choice ?? message);
    return true;
  }

  /**
   * Bridges the SDK's permission prompt to the phone. Denies on timeout so a
   * forgotten request cannot wedge the turn forever.
   */
  /**
   * The agent's AskUserQuestion tool has no headless UI, so we intercept it
   * pre-tool-use, show the choices on the phone and return the picked option
   * back to the model as a synthetic tool result via permissionDecision:deny
   * — the SDK feeds `permissionDecisionReason` straight into the transcript.
   */
  private askUserQuestionHook(channel: EventChannel<ProviderTurnEvent>): HookCallback {
    return async (rawInput, _toolUseId, options): Promise<SyncHookJSONOutput> => {
      const input = rawInput as PreToolUseHookInput;
      if (input.tool_name !== "AskUserQuestion") return { continue: true };
      const question = parseUserQuestion(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
      if (!question) return { continue: true };
      const answer = await this.awaitPhoneAnswer(channel, {
        toolName: input.tool_name,
        question,
        abortSignal: options.signal,
      });
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: answer.allow
            ? `Пользователь ответил: ${answer.detail ?? "(без выбора)"}`
            : answer.detail ?? "Пользователь не ответил",
        },
      } as SyncHookJSONOutput;
    };
  }

  /** Shared plumbing: publish an approval event, wait for the phone. */
  private awaitPhoneAnswer(
    channel: EventChannel<ProviderTurnEvent>,
    request: {
      toolName: string;
      abortSignal: AbortSignal;
      question?: ReturnType<typeof parseUserQuestion>;
      summary?: string;
    },
  ): Promise<{ allow: boolean; detail?: string }> {
    return new Promise((resolve) => {
      const id = randomUUID();
      const settle = (allow: boolean, detail?: string) => {
        clearTimeout(timer);
        this.pendingApprovals.delete(id);
        channel.push({
          type: "approval.request",
          payload: { id, toolName: request.toolName, resolved: true, allow, ...(detail ? { answer: detail } : {}) },
        });
        resolve({ allow, detail });
      };
      const timer = setTimeout(() => settle(false, "Нет ответа с телефона"), APPROVAL_TIMEOUT_MS);
      timer.unref?.();
      request.abortSignal.addEventListener("abort", () => settle(false, "Ход прерван"), { once: true });
      this.pendingApprovals.set(id, settle);
      channel.push({
        type: "approval.request",
        payload: request.question
          ? { id, toolName: request.toolName, kind: "question", resolved: false, ...request.question }
          : { id, toolName: request.toolName, kind: "permission", summary: request.summary, resolved: false },
      });
    });
  }

  private askPhone(channel: EventChannel<ProviderTurnEvent>): CanUseTool {
    return async (toolName, input, options): Promise<PermissionResult> => {
      const answer = await this.awaitPhoneAnswer(channel, {
        toolName,
        abortSignal: options.signal,
        summary: summarizeToolInput(toolName, input),
      });
      return answer.allow
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: answer.detail ?? "Отклонено с телефона" };
    };
  }

  private captureRateLimit(message: SDKMessage): void {
    const record = message as unknown as Record<string, unknown>;
    if (record.type !== "rate_limit_event") return;
    const info = asObject(record.rate_limit_info);
    if (!info) return;
    const raw = typeof info.utilization === "number" ? info.utilization : undefined;
    // The field is a share on some builds and a percentage on others; values
    // at or below 1 are treated as a fraction.
    const usedPercent = raw === undefined
      ? undefined
      : Math.round(raw <= 1 ? raw * 100 : raw);
    this.limits = {
      ...(usedPercent !== undefined ? { usedPercent } : {}),
      ...(typeof info.resetsAt === "number" ? { resetsAt: info.resetsAt } : {}),
      ...(windowMinutesFor(info.rateLimitType) !== undefined
        ? { windowMinutes: windowMinutesFor(info.rateLimitType) }
        : {}),
      ...(info.status === "allowed" || info.status === "rejected"
        ? { status: info.status }
        : info.status === "allowed_warning" ? { status: "warning" as const } : {}),
    };
  }

  private claudeExecutable(): string | undefined {
    if (this.resolvedExecutable === undefined) {
      this.resolvedExecutable = resolveClaudeExecutable(this.configuredExecutable) ?? null;
    }
    return this.resolvedExecutable ?? undefined;
  }
}


function* mapClaudeStreamMessage(message: SDKMessage): Generator<ProviderTurnEvent> {
  const record = message as unknown as Record<string, unknown>;
  const type = record.type;
  if (type === "assistant" || type === "user") {
    const uuid = typeof record.uuid === "string" ? record.uuid : `stream-${Math.random().toString(36).slice(2)}`;
    const items = normalizeClaudeMessages([{
      type,
      uuid,
      session_id: typeof record.session_id === "string" ? record.session_id : "",
      parent_tool_use_id: null,
      parent_agent_id: null,
      message: record.message,
      // Live stream messages carry no transcript timestamp; stamp receive time.
      timestamp: new Date().toISOString(),
    } as unknown as SessionMessage]);
    for (const item of items) {
      yield { type: "item.complete", payload: { item } };
    }
  } else if (type === "result") {
    const failed = record.subtype !== "success" || record.is_error === true;
    yield {
      type: "turn.status",
      payload: {
        status: failed ? "failed" : "completed",
        ...(typeof record.result === "string" ? { detail: record.result } : {}),
      },
    };
  }
}

export function normalizeClaudeMessages(messages: readonly SessionMessage[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const tools = new Map<string, TimelineItem>();

  for (const sessionMessage of messages) {
    const message = asObject(sessionMessage.message);
    const content = message?.content ?? sessionMessage.message;
    const blocks = Array.isArray(content) ? content : [content];
    const at = extractTimestamp(sessionMessage);
    const stamp = at !== undefined ? { at } : {};
    const textParts: string[] = [];
    let textBlockIndex = 0;
    const flushText = () => {
      const text = textParts.join("\n").trim();
      textParts.length = 0;
      if (!text || sessionMessage.type === "system") return;
      items.push({
        id: textBlockIndex === 0 ? sessionMessage.uuid : `${sessionMessage.uuid}:text:${textBlockIndex}`,
        kind: "message",
        role: sessionMessage.type,
        text,
        status: "completed",
        ...stamp,
      });
      textBlockIndex += 1;
    };

    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (typeof block === "string") {
        textParts.push(block);
        continue;
      }
      const record = asObject(block);
      if (!record) continue;
      if (record.type === "text" && typeof record.text === "string") {
        textParts.push(record.text);
      } else if (record.type === "thinking" && typeof record.thinking === "string") {
        flushText();
        items.push({
          id: `${sessionMessage.uuid}:thinking:${index}`,
          kind: "reasoning",
          text: record.thinking,
          status: "completed",
          ...stamp,
        });
      } else if (record.type === "tool_use") {
        flushText();
        const id = typeof record.id === "string" ? record.id : `${sessionMessage.uuid}:tool:${index}`;
        const tool: TimelineItem = {
          id,
          kind: "tool",
          text: typeof record.name === "string" ? record.name : "tool",
          status: "running",
          ...stamp,
        };
        tools.set(id, tool);
        items.push(tool);
      } else if (record.type === "tool_result") {
        flushText();
        const toolUseId = typeof record.tool_use_id === "string" ? record.tool_use_id : undefined;
        if (!toolUseId) continue;
        const resultText = extractText(record.content);
        const existing = tools.get(toolUseId);
        if (existing) {
          existing.status = record.is_error === true ? "failed" : "completed";
          if (resultText) existing.text = `${existing.text ?? "tool"}\n${resultText}`;
        } else {
          const result: TimelineItem = {
            id: toolUseId,
            kind: "tool",
            text: resultText || "tool result",
            status: record.is_error === true ? "failed" : "completed",
            ...stamp,
          };
          tools.set(toolUseId, result);
          items.push(result);
        }
      }
    }
    flushText();
  }

  return items;
}

function extractTimestamp(sessionMessage: SessionMessage): number | undefined {
  const record = sessionMessage as unknown as Record<string, unknown>;
  const raw = record.timestamp;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      const record = asObject(part);
      return record?.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Recognises the agent asking the user to choose. The tool has no interface
 * in a headless session, so the phone provides one.
 */
export function parseUserQuestion(
  toolName: string,
  input: Record<string, unknown>,
): { question: string; options: string[]; multiSelect: boolean } | undefined {
  if (toolName !== "AskUserQuestion") return undefined;
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const first = questions[0] as Record<string, unknown> | undefined;
  if (!first) return undefined;
  const options = Array.isArray(first.options)
    ? first.options
        .map((option) => {
          if (typeof option === "string") return option;
          const record = option as Record<string, unknown>;
          return typeof record?.label === "string" ? record.label : undefined;
        })
        .filter((label): label is string => Boolean(label))
    : [];
  return {
    question: typeof first.question === "string" ? first.question : toolName,
    options,
    multiSelect: first.multiSelect === true,
  };
}

/** One readable line describing what the tool is about to do. */
export function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  for (const key of ["command", "file_path", "path", "pattern", "url", "prompt", "description"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      const single = value.replace(/\s+/g, " ").trim();
      return single.length > 200 ? `${single.slice(0, 200)}…` : single;
    }
  }
  return toolName;
}

function windowMinutesFor(rateLimitType: unknown): number | undefined {
  if (typeof rateLimitType !== "string") return undefined;
  if (rateLimitType === "five_hour") return 5 * 60;
  return rateLimitType.startsWith("seven_day") ? 7 * 24 * 60 : undefined;
}

function projectName(cwd: string): string | undefined {
  return cwd.split(/[\\/]/).filter(Boolean).at(-1);
}
