import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ProviderAdapter,
  ProviderSessionSnapshot,
  ProviderSessionSummary,
  ProviderTurnEvent,
} from "../gateway/provider-adapter.js";
import type { TimelineItem } from "../gateway/protocol.js";
import { JsonRpcProcess } from "./json-rpc-client.js";

export interface CodexSessionSource {
  listThreads(): Promise<unknown>;
  readThread(threadId: string): Promise<unknown>;
}

export interface CodexReadOnlyAdapterOptions {
  cwd?: string;
  limit?: number;
  executable?: string;
  source?: CodexSessionSource;
}

export class CodexReadOnlyAdapter implements ProviderAdapter {
  readonly provider = "codex" as const;
  private readonly cwd?: string;
  private readonly limit: number;
  private readonly source: CodexSessionSource;

  constructor(options: CodexReadOnlyAdapterOptions = {}) {
    this.cwd = options.cwd;
    this.limit = options.limit ?? 50;
    this.source = options.source ?? new AppServerCodexSource(options.executable, this.limit);
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
          capabilities: { canRead: true, canStartTurn: false, canApprove: false },
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

  async *startTurn(_providerSessionId: string, _text: string): AsyncIterable<ProviderTurnEvent> {
    throw new Error("Codex existing-session resume remains disabled until the acceptance check passes.");
  }
}

class AppServerCodexSource implements CodexSessionSource {
  constructor(private readonly configuredExecutable?: string, private readonly limit = 50) {}

  async listThreads(): Promise<unknown> {
    return this.request("thread/list", { limit: this.limit });
  }

  async readThread(threadId: string): Promise<unknown> {
    return this.request("thread/read", { threadId, includeTurns: true });
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const appServer = await JsonRpcProcess.start(resolveCodexExecutable(this.configuredExecutable), ["app-server", "--stdio"]);
    try {
      const initialized = await appServer.request("initialize", {
        clientInfo: { name: "vscode-llm-mobile-bridge", title: "LLM Mobile Bridge", version: "0.1.0" },
      });
      if (initialized.error) throw new Error(initialized.error.message ?? "Codex initialize failed");
      appServer.notify("initialized", {});
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
    if (item.type === "userMessage") {
      items.push({ id, kind: "message", role: "user", text: extractText(item.content), status: "completed" });
    } else if (item.type === "agentMessage") {
      items.push({ id, kind: "message", role: "assistant", text: stringOrEmpty(item.text), status: "completed" });
    } else if (item.type === "reasoning") {
      const summary = extractText(item.summary);
      const content = extractText(item.content);
      items.push({ id, kind: "reasoning", text: summary || content || "Reasoning", status: "completed" });
    } else {
      const label = firstString(item, ["name", "tool", "command", "query", "review", "result"]) ?? humanize(item.type);
      const output = firstString(item, ["aggregatedOutput", "output"]);
      items.push({
        id,
        kind: "tool",
        text: output ? `${label}\n${output}` : label,
        status: normalizeStatus(item.status),
      });
    }
  }
  return items.filter((item) => item.text?.trim().length);
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
