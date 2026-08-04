import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Locates the provider CLIs. They live in different places depending on the
 * machine: a Remote-SSH host keeps VS Code extensions under `.vscode-server`
 * and uses unsuffixed binaries, while a desktop install uses `.vscode` and
 * `.exe`. Reading transcripts needs none of this, so a wrong answer here
 * shows up only as empty model lists and failed turns.
 */
const isWindows = process.platform === "win32";

/** Extension host directories, desktop and remote alike. */
function extensionRoots(): string[] {
  const home = homedir();
  return [
    join(home, ".vscode", "extensions"),
    join(home, ".vscode-server", "extensions"),
    join(home, ".vscode-insiders", "extensions"),
    join(home, ".vscode-server-insiders", "extensions"),
  ].filter(existsSync);
}

/** Newest-first directories inside `root` whose name starts with `prefix`. */
function extensionDirs(root: string, prefix: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => join(root, entry.name))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function firstExisting(candidates: readonly string[]): string | undefined {
  return candidates.find(existsSync);
}

/** Executables named `name` found on PATH, honouring the Windows suffix. */
function onPath(name: string): string[] {
  const names = isWindows ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`] : [name];
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .flatMap((dir) => names.map((candidate) => join(dir, candidate)));
}

export function resolveClaudeExecutable(configured?: string): string | undefined {
  if (configured?.trim()) return configured.trim();
  if (process.env.CLAUDE_BIN?.trim()) return process.env.CLAUDE_BIN.trim();

  const binary = isWindows ? "claude.exe" : "claude";
  const bundled = extensionRoots().flatMap((root) =>
    extensionDirs(root, "anthropic.claude-code-")
      .map((dir) => join(dir, "resources", "native-binary", binary)));

  return firstExisting([
    ...onPath("claude"),
    join(homedir(), ".local", "bin", binary),
    ...bundled,
  ]);
}

export function resolveCodexExecutable(configured?: string): string {
  if (configured?.trim()) return configured.trim();
  if (process.env.CODEX_BIN?.trim()) return process.env.CODEX_BIN.trim();

  const binary = isWindows ? "codex.exe" : "codex";
  // The ChatGPT extension ships per-platform folders (windows-x86_64,
  // linux-x64, darwin-arm64, …), so scan whatever it actually contains.
  const bundled = extensionRoots().flatMap((root) =>
    extensionDirs(root, "openai.chatgpt-").flatMap((dir) => {
      const binRoot = join(dir, "bin");
      try {
        return readdirSync(binRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(binRoot, entry.name, binary));
      } catch {
        return [];
      }
    }));

  return firstExisting([
    ...onPath("codex"),
    join(homedir(), ".local", "bin", binary),
    ...bundled,
  ]) ?? "codex";
}
