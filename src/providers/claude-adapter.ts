import {
  getSessionInfo,
  getSessionMessages,
  listSessions,
  query,
  type GetSessionInfoOptions,
  type GetSessionMessagesOptions,
  type ListSessionsOptions,
  type Options,
  type SDKMessage,
  type SDKSessionInfo,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ProviderAdapter,
  ProviderSessionSnapshot,
  ProviderSessionSummary,
  ProviderTurnEvent,
} from "../gateway/provider-adapter.js";
import type { TimelineItem } from "../gateway/protocol.js";

export interface ClaudeSessionSource {
  listSessions(options?: ListSessionsOptions): Promise<SDKSessionInfo[]>;
  getSessionInfo(sessionId: string, options?: GetSessionInfoOptions): Promise<SDKSessionInfo | undefined>;
  getSessionMessages(sessionId: string, options?: GetSessionMessagesOptions): Promise<SessionMessage[]>;
  runQuery(params: { prompt: string; options?: Options }): AsyncIterable<SDKMessage>;
}

export type ClaudePermissionMode = "default" | "acceptEdits" | "bypassPermissions";

export interface ClaudeReadOnlyAdapterOptions {
  dir?: string;
  limit?: number;
  allowTurns?: boolean;
  permissionMode?: ClaudePermissionMode;
  source?: ClaudeSessionSource;
}

const sdkSource: ClaudeSessionSource = {
  listSessions,
  getSessionInfo,
  getSessionMessages,
  runQuery: (params) => query(params),
};

export class ClaudeReadOnlyAdapter implements ProviderAdapter {
  readonly provider = "claude" as const;
  private readonly dir?: string;
  private readonly limit: number;
  private readonly allowTurns: boolean;
  private readonly permissionMode: ClaudePermissionMode;
  private readonly source: ClaudeSessionSource;

  constructor(options: ClaudeReadOnlyAdapterOptions = {}) {
    this.dir = options.dir;
    this.limit = options.limit ?? 100;
    this.allowTurns = options.allowTurns ?? true;
    this.permissionMode = options.permissionMode ?? "default";
    this.source = options.source ?? sdkSource;
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

  async *startTurn(providerSessionId: string, text: string): AsyncIterable<ProviderTurnEvent> {
    if (!this.allowTurns) throw new Error("Sending messages to Claude sessions is disabled in settings.");
    const info = await this.source.getSessionInfo(
      providerSessionId,
      this.dir ? { dir: this.dir } : undefined,
    );
    const stream = this.source.runQuery({
      prompt: text,
      options: {
        resume: providerSessionId,
        ...(info?.cwd ? { cwd: info.cwd } : {}),
        permissionMode: this.permissionMode,
      },
    });
    for await (const message of stream) {
      yield* mapClaudeStreamMessage(message);
    }
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

function projectName(cwd: string): string | undefined {
  return cwd.split(/[\\/]/).filter(Boolean).at(-1);
}
