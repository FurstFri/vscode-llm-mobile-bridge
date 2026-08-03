import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSessionMessages, listSessions } from "@anthropic-ai/claude-agent-sdk";
import { ProviderProbe, ProbeResult } from "../model.js";
import { commandExists, runCommand } from "./process.js";

function countJsonl(directory: string): number {
  if (!existsSync(directory)) return 0;
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).length;
}

export class ClaudeProbe implements ProviderProbe {
  readonly provider = "claude" as const;

  constructor(private readonly configuredExecutable = process.env.CLAUDE_BIN) {}

  private bundledExecutable(): string | undefined {
    const extensionRoot = join(homedir(), ".vscode", "extensions");
    if (!existsSync(extensionRoot)) return undefined;
    const candidates = readdirSync(extensionRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("anthropic.claude-code-"))
      .map((entry) => join(extensionRoot, entry.name, "resources", "native-binary", "claude.exe"))
      .filter(existsSync)
      .sort();
    return candidates.at(-1);
  }

  private async resolveExecutable(): Promise<{ executable?: string; source: string }> {
    if (this.configuredExecutable) return { executable: this.configuredExecutable, source: "CLAUDE_BIN" };
    if (await commandExists("claude")) return { executable: "claude", source: "PATH" };
    const bundled = this.bundledExecutable();
    return bundled ? { executable: bundled, source: "VS Code Claude Code extension" } : { source: "not found" };
  }

  async run(): Promise<ProbeResult> {
    const transcriptDirectory = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
    const transcriptCount = countJsonl(transcriptDirectory);
    const candidate = await this.resolveExecutable();
    if (!candidate.executable) {
      return {
        provider: this.provider,
        status: "unavailable",
        summary: "Claude CLI is not available in this environment; no session was touched.",
        evidence: { executable: "claude", source: candidate.source, transcriptDirectory, transcriptCount },
        nextStep: "Install the standalone Claude CLI or configure CLAUDE_BIN.",
      };
    }
    try {
      const version = await runCommand(candidate.executable, ["--version"]);
      if (version.exitCode !== 0) throw new Error(version.stderr || "claude --version failed");
      const sessions = await listSessions({ limit: 5 });
      const latest = sessions.at(0);
      const messages = latest
        ? await getSessionMessages(latest.sessionId, { limit: 1, dir: latest.cwd })
        : [];
      return {
        provider: this.provider,
        status: "ready",
        summary: "Claude CLI and Agent SDK listed local sessions and read a transcript without starting a turn.",
        evidence: {
          executable: candidate.executable,
          source: candidate.source,
          version: version.stdout.trim(),
          transcriptDirectory,
          transcriptCount,
          listedSessions: sessions.length,
          readMessages: messages.length,
        },
        nextStep: "Next probe: resume an explicitly chosen test session with a user-supplied prompt.",
      };
    } catch (error) {
      return {
        provider: this.provider,
        status: "failed",
        summary: "Claude was found, but the Agent SDK could not list/read local sessions.",
        evidence: { executable: candidate.executable, source: candidate.source, transcriptDirectory, transcriptCount },
        nextStep: "Check local Claude session storage and the installed Agent SDK version.",
      };
    }
  }
}
