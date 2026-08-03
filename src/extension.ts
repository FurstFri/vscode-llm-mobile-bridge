import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { GatewayCore } from "./gateway/gateway-core.js";
import { ClaudeReadOnlyAdapter } from "./providers/claude-adapter.js";
import { CodexReadOnlyAdapter } from "./providers/codex-adapter.js";
import { LocalGatewayServer } from "./transport/local-gateway-server.js";

const SECRET_KEY = "llmMobileBridge.pairingToken";

class BridgeController implements vscode.Disposable {
  private server?: LocalGatewayServer;
  private activePort?: number;
  private readonly status: vscode.StatusBarItem;
  private readonly output: vscode.LogOutputChannel;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel("LLM Mobile Bridge", { log: true });
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.status.command = "llmMobileBridge.copyPairing";
    this.setStopped();
    this.status.show();
  }

  async start(): Promise<void> {
    if (this.server) return;
    if (!vscode.workspace.isTrusted) {
      await vscode.window.showWarningMessage("LLM Mobile Bridge starts only in a trusted workspace.");
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      await vscode.window.showWarningMessage("Open a workspace folder before starting LLM Mobile Bridge.");
      return;
    }
    const config = vscode.workspace.getConfiguration("llmMobileBridge");
    const port = config.get<number>("port", 8765);
    const token = await this.getOrCreateToken();
    const gateway = new GatewayCore([
      new ClaudeReadOnlyAdapter({ dir: folder.uri.fsPath }),
      new CodexReadOnlyAdapter({ cwd: folder.uri.fsPath }),
    ]);
    const server = new LocalGatewayServer({ gateway, token, port, host: "127.0.0.1" });
    try {
      this.activePort = await server.start();
      this.server = server;
      this.status.text = "$(radio-tower) LLM Bridge: local";
      this.status.tooltip = "Loopback gateway is running. Click to copy pairing payload.";
      this.output.info(`Gateway started on loopback port ${this.activePort}.`);
    } catch (error) {
      this.activePort = undefined;
      await server.stop();
      this.setStopped();
      const message = error instanceof Error ? error.message : String(error);
      this.output.error(`Gateway failed to start: ${message}`);
      await vscode.window.showErrorMessage(`LLM Mobile Bridge could not start: ${message}`);
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.activePort = undefined;
    await server?.stop();
    this.setStopped();
    this.output.info("Gateway stopped.");
  }

  async copyPairing(): Promise<void> {
    if (!this.server || !this.activePort) await this.start();
    if (!this.server || !this.activePort) return;
    const token = await this.getOrCreateToken();
    const configuredUrl = vscode.workspace.getConfiguration("llmMobileBridge")
      .get<string>("mobileUrl", `ws://10.0.2.2:${this.activePort}`);
    const url = replacePort(configuredUrl, this.activePort);
    await vscode.env.clipboard.writeText(JSON.stringify({ protocolVersion: 1, url, token }));
    await vscode.window.showInformationMessage("LLM Mobile Bridge pairing payload copied to the clipboard.");
  }

  async disconnectAll(): Promise<void> {
    await this.stop();
    await this.context.secrets.store(SECRET_KEY, createToken());
    await this.start();
    await vscode.window.showInformationMessage("All mobile sessions were disconnected and the pairing token was rotated.");
  }

  dispose(): void {
    void this.stop();
    this.status.dispose();
    this.output.dispose();
  }

  private async getOrCreateToken(): Promise<string> {
    const stored = await this.context.secrets.get(SECRET_KEY);
    if (stored) return stored;
    const token = createToken();
    await this.context.secrets.store(SECRET_KEY, token);
    return token;
  }

  private setStopped(): void {
    this.status.text = "$(debug-disconnect) LLM Bridge: stopped";
    this.status.tooltip = "Run “LLM Mobile Bridge: Start Gateway” to enable the loopback gateway.";
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const controller = new BridgeController(context);
  context.subscriptions.push(
    controller,
    vscode.commands.registerCommand("llmMobileBridge.start", () => controller.start()),
    vscode.commands.registerCommand("llmMobileBridge.stop", () => controller.stop()),
    vscode.commands.registerCommand("llmMobileBridge.copyPairing", () => controller.copyPairing()),
    vscode.commands.registerCommand("llmMobileBridge.disconnectAll", () => controller.disconnectAll()),
  );
  const autoStart = vscode.workspace.getConfiguration("llmMobileBridge").get<boolean>("autoStart", true);
  if (autoStart && vscode.workspace.isTrusted && vscode.workspace.workspaceFolders?.length) await controller.start();
}

export function deactivate(): void {}

function createToken(): string {
  return randomBytes(32).toString("base64url");
}

function replacePort(url: string, port: number): string {
  try {
    const parsed = new URL(url);
    parsed.port = String(port);
    return parsed.toString();
  } catch {
    return `ws://10.0.2.2:${port}`;
  }
}
