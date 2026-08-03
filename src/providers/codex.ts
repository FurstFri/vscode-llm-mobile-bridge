import { existsSync } from "node:fs";
import { ProviderProbe, ProbeResult } from "../model.js";
import { JsonRpcProcess } from "./json-rpc-client.js";
import { runCommand } from "./process.js";

export class CodexProbe implements ProviderProbe {
  readonly provider = "codex" as const;

  constructor(private readonly executable = process.env.CODEX_BIN ?? "codex") {}

  async run(): Promise<ProbeResult> {
    try {
      const help = await runCommand(this.executable, ["app-server", "--help"]);
      if (help.exitCode !== 0 || !help.stdout.includes("generate-json-schema")) {
        return {
          provider: this.provider,
          status: "unavailable",
          summary: "Codex App Server is not available from this executable.",
          evidence: { executable: this.executable, exitCode: help.exitCode ?? -1 },
          nextStep: "Install or update the Codex CLI/IDE extension on the Windows host.",
        };
      }

      const appServer = await JsonRpcProcess.start(this.executable, ["app-server", "--stdio"]);
      let initialized;
      let list;
      let read;
      let listedThreadCount = 0;
      try {
        initialized = await appServer.request("initialize", { clientInfo: { name: "vscode-llm-mobile-bridge", version: "0.1.0" } });
        appServer.notify("initialized", {});
        list = await appServer.request("thread/list", { limit: 5 });
        const data = asObject(list.result)?.data;
        listedThreadCount = Array.isArray(data) ? data.length : 0;
        const firstThread = Array.isArray(data) ? asObject(data[0]) : undefined;
        const threadId = typeof firstThread?.id === "string" ? firstThread.id : undefined;
        if (threadId) read = await appServer.request("thread/read", { threadId, includeTurns: false });
      } finally {
        appServer.close();
      }
      if (initialized?.error || list?.error) {
        return {
          provider: this.provider,
          status: "blocked",
          summary: "Codex App Server started but rejected the compatibility probe.",
          evidence: {
            executable: this.executable,
            initializeError: initialized?.error?.message ?? "",
            threadListError: list?.error?.message ?? "",
          },
          nextStep: "Check local Codex authentication/configuration; no conversation was modified.",
        };
      }
      return {
        provider: this.provider,
        status: "ready",
        summary: "Codex App Server accepted initialize and thread/list.",
        evidence: {
          executable: this.executable,
          initialized: Boolean(initialized?.result),
          threadsListed: listedThreadCount,
          threadRead: Boolean(read?.result),
        },
        nextStep: "Manually compare an existing IDE thread with thread/read, then test thread/resume on a copy.",
      };
    } catch (error) {
      return {
        provider: this.provider,
        status: existsSync(this.executable) ? "failed" : "unavailable",
        summary: "Could not complete the Codex compatibility probe.",
        evidence: { executable: this.executable, error: error instanceof Error ? error.message : String(error) },
        nextStep: "Verify CODEX_BIN points to a working Codex executable.",
      };
    }
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
