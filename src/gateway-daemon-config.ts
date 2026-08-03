import { randomBytes } from "node:crypto";

export type GatewayDaemonCommand = "serve" | "pairing" | "health" | "token";

export interface GatewayDaemonConfig {
  command: GatewayDaemonCommand;
  token?: string;
  host: string;
  port: number;
  mobileUrl: string;
  enableClaude: boolean;
  enableCodex: boolean;
  allowTurns: boolean;
  claudeProjectDir?: string;
  codexCwd?: string;
  codexExecutable?: string;
}

export function parseGatewayDaemonConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2),
): GatewayDaemonConfig {
  const command = parseCommand(argv[0]);
  const port = parsePort(env.BRIDGE_PORT);
  const token = env.BRIDGE_TOKEN;

  if (command !== "token") validateToken(token);

  return {
    command,
    token,
    host: nonEmpty(env.BRIDGE_HOST) ?? "0.0.0.0",
    port,
    mobileUrl: parseMobileUrl(env.BRIDGE_MOBILE_URL, port),
    enableClaude: parseBoolean("BRIDGE_ENABLE_CLAUDE", env.BRIDGE_ENABLE_CLAUDE, true),
    enableCodex: parseBoolean("BRIDGE_ENABLE_CODEX", env.BRIDGE_ENABLE_CODEX, true),
    // The container mounts provider data read-only, so sending turns stays opt-in there.
    allowTurns: parseBoolean("BRIDGE_ALLOW_TURNS", env.BRIDGE_ALLOW_TURNS, false),
    claudeProjectDir: nonEmpty(env.BRIDGE_CLAUDE_PROJECT_DIR),
    codexCwd: nonEmpty(env.BRIDGE_CODEX_CWD),
    codexExecutable: nonEmpty(env.CODEX_BIN),
  };
}

export function createPairingToken(): string {
  return randomBytes(32).toString("base64url");
}

function parseCommand(value: string | undefined): GatewayDaemonCommand {
  const command = value ?? "serve";
  if (command === "serve" || command === "pairing" || command === "health" || command === "token") return command;
  throw new Error(`Unknown gateway command: ${command}`);
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") return 8765;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("BRIDGE_PORT must be an integer between 1 and 65535.");
  }
  return port;
}

function parseBoolean(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be true, false, 1, or 0.`);
}

function parseMobileUrl(value: string | undefined, port: number): string {
  const candidate = nonEmpty(value) ?? `ws://10.0.2.2:${port}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("BRIDGE_MOBILE_URL must be a valid ws:// or wss:// URL.");
  }
  if ((parsed.protocol !== "ws:" && parsed.protocol !== "wss:") || parsed.username || parsed.password || parsed.hash) {
    throw new Error("BRIDGE_MOBILE_URL must be a ws:// or wss:// URL without credentials or a fragment.");
  }
  return parsed.toString();
}

function validateToken(token: string | undefined): asserts token is string {
  if (!token || token.length < 32 || token !== token.trim()) {
    throw new Error("BRIDGE_TOKEN is required and must contain at least 32 non-whitespace characters.");
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
