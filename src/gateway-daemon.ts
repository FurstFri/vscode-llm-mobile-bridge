import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { GatewayCore } from "./gateway/gateway-core.js";
import type { ProviderAdapter } from "./gateway/provider-adapter.js";
import {
  createPairingToken,
  parseGatewayDaemonConfig,
  type GatewayDaemonConfig,
} from "./gateway-daemon-config.js";
import { ClaudeReadOnlyAdapter } from "./providers/claude-adapter.js";
import { CodexReadOnlyAdapter } from "./providers/codex-adapter.js";
import { LocalGatewayServer } from "./transport/local-gateway-server.js";
import type { MobileRequest, MobileResponse } from "./transport/mobile-protocol.js";

const HEALTH_TIMEOUT_MS = 5_000;

export async function runGatewayDaemon(config: GatewayDaemonConfig): Promise<void> {
  if (config.command === "token") {
    process.stdout.write(`${createPairingToken()}\n`);
    return;
  }
  if (!config.token) throw new Error("BRIDGE_TOKEN is required.");
  if (config.command === "pairing") {
    process.stdout.write(`${JSON.stringify({ protocolVersion: 1, url: config.mobileUrl, token: config.token })}\n`);
    return;
  }
  if (config.command === "health") {
    await checkGatewayHealth(`ws://127.0.0.1:${config.port}`, config.token);
    return;
  }

  const adapters: ProviderAdapter[] = [];
  if (config.enableClaude) {
    adapters.push(new ClaudeReadOnlyAdapter({ dir: config.claudeProjectDir, allowTurns: config.allowTurns }));
  }
  if (config.enableCodex) {
    adapters.push(new CodexReadOnlyAdapter({
      cwd: config.codexCwd,
      executable: config.codexExecutable,
      allowTurns: config.allowTurns,
    }));
  }

  const server = new LocalGatewayServer({
    gateway: new GatewayCore(adapters),
    token: config.token,
    host: config.host,
    port: config.port,
  });
  const activePort = await server.start();
  const providers = adapters.map((adapter) => adapter.provider).join(", ") || "none";
  process.stdout.write(`LLM Mobile Bridge gateway listening on ${config.host}:${activePort}; providers: ${providers}.\n`);

  const signal = await waitForShutdownSignal();
  process.stdout.write(`Received ${signal}; stopping gateway.\n`);
  await server.stop();
}

export async function checkGatewayHealth(url: string, token: string): Promise<void> {
  const socket = new WebSocket(url);
  const timeout = setTimeout(() => socket.close(), HEALTH_TIMEOUT_MS);

  try {
    await new Promise<void>((resolveHealth, reject) => {
      let authenticated = false;
      socket.once("open", () => send(socket, { protocolVersion: 1, id: "health-auth", type: "auth", token }));
      socket.on("message", (data) => {
        let response: MobileResponse;
        try {
          response = JSON.parse(data.toString("utf8")) as MobileResponse;
        } catch {
          reject(new Error("Gateway health response was not valid JSON."));
          return;
        }
        if (!response.ok) {
          reject(new Error(`Gateway health authentication failed: ${response.error.code}.`));
        } else if (!authenticated && response.type === "auth.ready") {
          authenticated = true;
          send(socket, { protocolVersion: 1, id: "health-ping", type: "ping" });
        } else if (authenticated && response.type === "pong") {
          resolveHealth();
        }
      });
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("Gateway closed before the health check completed.")));
    });
  } finally {
    clearTimeout(timeout);
    socket.close();
  }
}

function send(socket: WebSocket, request: MobileRequest): void {
  socket.send(JSON.stringify(request));
}

function waitForShutdownSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolveSignal) => {
    process.once("SIGINT", resolveSignal);
    process.once("SIGTERM", resolveSignal);
  });
}

async function main(): Promise<void> {
  await runGatewayDaemon(parseGatewayDaemonConfig());
}

const executableUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (executableUrl === import.meta.url) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Gateway failed: ${message}\n`);
    process.exitCode = 1;
  });
}
