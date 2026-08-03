import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { GatewayCore } from "./gateway/gateway-core.js";
import type { SessionDescriptor, TimelineItem } from "./gateway/protocol.js";
import { ClaudeReadOnlyAdapter, type ClaudePermissionMode } from "./providers/claude-adapter.js";
import { CodexReadOnlyAdapter } from "./providers/codex-adapter.js";
import { LocalGatewayServer } from "./transport/local-gateway-server.js";

const SECRET_KEY = "llmMobileBridge.pairingToken";

class BridgeController implements vscode.Disposable {
  private server?: LocalGatewayServer;
  private gateway?: GatewayCore;
  private activePort?: number;
  private readonly status: vscode.StatusBarItem;
  readonly output: vscode.LogOutputChannel;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel("LLM Mobile Bridge", { log: true });
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.status.command = "llmMobileBridge.copyPairing";
    this.setStopped();
    this.status.show();
  }

  get running(): boolean {
    return Boolean(this.server);
  }

  get port(): number | undefined {
    return this.activePort;
  }

  async start(): Promise<void> {
    if (this.server) return;
    if (!vscode.workspace.isTrusted) {
      await vscode.window.showWarningMessage("LLM Mobile Bridge starts only in a trusted workspace.");
      return;
    }
    const config = vscode.workspace.getConfiguration("llmMobileBridge");
    const port = config.get<number>("port", 8765);
    const token = await this.getOrCreateToken();
    const gateway = this.ensureGateway(true);
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
    this.changeEmitter.fire();
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.activePort = undefined;
    await server?.stop();
    this.setStopped();
    this.output.info("Gateway stopped.");
    this.changeEmitter.fire();
  }

  async copyPairing(): Promise<void> {
    if (!this.server || !this.activePort) await this.start();
    if (!this.server || !this.activePort) return;
    const token = await this.getOrCreateToken();
    const configuredUrl = vscode.workspace.getConfiguration("llmMobileBridge")
      .get<string>("mobileUrl", `ws://10.0.2.2:${this.activePort}`);
    const url = buildMobileUrl(configuredUrl, this.activePort);
    await vscode.env.clipboard.writeText(JSON.stringify({ protocolVersion: 1, url, token }));
    await vscode.window.showInformationMessage("LLM Mobile Bridge pairing payload copied to the clipboard.");
  }

  async disconnectAll(): Promise<void> {
    await this.stop();
    await this.context.secrets.store(SECRET_KEY, createToken());
    await this.start();
    await vscode.window.showInformationMessage("All mobile sessions were disconnected and the pairing token was rotated.");
  }

  async listSessions(): Promise<SessionDescriptor[]> {
    const gateway = this.ensureGateway(false);
    const event = await gateway.listSessions();
    return event.payload.sessions;
  }

  async readTimeline(ref: string): Promise<{ session: SessionDescriptor; items: TimelineItem[] }> {
    const gateway = this.ensureGateway(false);
    const event = await gateway.readSnapshot(ref);
    return event.payload as { session: SessionDescriptor; items: TimelineItem[] };
  }

  invalidateGateway(): void {
    if (!this.server) this.gateway = undefined;
    this.changeEmitter.fire();
  }

  dispose(): void {
    void this.stop();
    this.status.dispose();
    this.output.dispose();
    this.changeEmitter.dispose();
  }

  private ensureGateway(rebuild: boolean): GatewayCore {
    if (this.gateway && !rebuild) return this.gateway;
    if (this.gateway && rebuild && this.server) return this.gateway;
    const config = vscode.workspace.getConfiguration("llmMobileBridge");
    const scope = config.get<string>("sessionScope", "all");
    const limit = config.get<number>("sessionLimit", 100);
    const allowTurns = config.get<boolean>("allowSendingMessages", true);
    const permissionMode = config.get<ClaudePermissionMode>("claudePermissionMode", "default");
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const dir = scope === "workspace" ? folder : undefined;
    this.gateway = new GatewayCore([
      new ClaudeReadOnlyAdapter({ dir, limit, allowTurns, permissionMode }),
      new CodexReadOnlyAdapter({ cwd: dir, limit, allowTurns }),
    ]);
    return this.gateway;
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

type BridgeTreeNode =
  | { kind: "status" }
  | { kind: "action"; label: string; icon: string; command: string }
  | { kind: "provider"; provider: "claude" | "codex"; label: string }
  | { kind: "session"; session: SessionDescriptor }
  | { kind: "empty"; label: string };

class BridgeTreeProvider implements vscode.TreeDataProvider<BridgeTreeNode> {
  private readonly emitter = new vscode.EventEmitter<BridgeTreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private sessions: SessionDescriptor[] = [];
  private loadError?: string;

  constructor(private readonly controller: BridgeController) {
    controller.onDidChange(() => this.refresh());
  }

  refresh(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.sessions = await this.controller.listSessions();
      this.sessions.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
      this.loadError = undefined;
    } catch (error) {
      this.sessions = [];
      this.loadError = error instanceof Error ? error.message : String(error);
    }
    this.emitter.fire(undefined);
  }

  getTreeItem(node: BridgeTreeNode): vscode.TreeItem {
    if (node.kind === "status") {
      const running = this.controller.running;
      const item = new vscode.TreeItem(
        running ? `Шлюз запущен · порт ${this.controller.port}` : "Шлюз остановлен",
      );
      item.iconPath = new vscode.ThemeIcon(running ? "radio-tower" : "debug-disconnect");
      item.contextValue = running ? "gatewayRunning" : "gatewayStopped";
      return item;
    }
    if (node.kind === "action") {
      const item = new vscode.TreeItem(node.label);
      item.iconPath = new vscode.ThemeIcon(node.icon);
      item.command = { command: node.command, title: node.label };
      return item;
    }
    if (node.kind === "provider") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon(node.provider === "claude" ? "hubot" : "terminal");
      return item;
    }
    if (node.kind === "empty") {
      const item = new vscode.TreeItem(node.label);
      item.iconPath = new vscode.ThemeIcon("info");
      return item;
    }
    const session = node.session;
    const item = new vscode.TreeItem(session.title ?? "Без названия");
    item.description = [session.project, formatWhen(session.updatedAt)].filter(Boolean).join(" · ");
    item.tooltip = `${session.title ?? "Без названия"}\n${session.project ?? ""}\n${session.state}`;
    item.iconPath = new vscode.ThemeIcon("comment-discussion");
    item.command = {
      command: "llmMobileBridge.openSession",
      title: "Открыть транскрипт",
      arguments: [session.ref, session.title ?? "Транскрипт"],
    };
    return item;
  }

  getChildren(node?: BridgeTreeNode): BridgeTreeNode[] {
    if (!node) {
      const actions: BridgeTreeNode[] = this.controller.running
        ? [
            { kind: "action", label: "Скопировать пейринг для телефона", icon: "device-mobile", command: "llmMobileBridge.copyPairing" },
            { kind: "action", label: "Остановить шлюз", icon: "debug-stop", command: "llmMobileBridge.stop" },
            { kind: "action", label: "Отключить все устройства", icon: "circle-slash", command: "llmMobileBridge.disconnectAll" },
          ]
        : [{ kind: "action", label: "Запустить шлюз", icon: "play", command: "llmMobileBridge.start" }];
      return [
        { kind: "status" },
        ...actions,
        { kind: "provider", provider: "claude", label: "Claude Code" },
        { kind: "provider", provider: "codex", label: "Codex" },
      ];
    }
    if (node.kind === "provider") {
      if (this.loadError) return [{ kind: "empty", label: `Ошибка: ${this.loadError}` }];
      const sessions = this.sessions.filter((session) => session.provider === node.provider);
      if (!sessions.length) return [{ kind: "empty", label: "Сессии не найдены" }];
      return sessions.map((session) => ({ kind: "session", session }));
    }
    return [];
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const controller = new BridgeController(context);
  const tree = new BridgeTreeProvider(controller);
  context.subscriptions.push(
    controller,
    vscode.window.registerTreeDataProvider("llmMobileBridge.panel", tree),
    vscode.commands.registerCommand("llmMobileBridge.start", () => controller.start()),
    vscode.commands.registerCommand("llmMobileBridge.stop", () => controller.stop()),
    vscode.commands.registerCommand("llmMobileBridge.copyPairing", () => controller.copyPairing()),
    vscode.commands.registerCommand("llmMobileBridge.disconnectAll", () => controller.disconnectAll()),
    vscode.commands.registerCommand("llmMobileBridge.refreshSessions", () => tree.refresh()),
    vscode.commands.registerCommand("llmMobileBridge.openSession", (ref: string, title: string) =>
      openTranscript(controller, ref, title)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("llmMobileBridge")) controller.invalidateGateway();
    }),
  );
  tree.refresh();
  const autoStart = vscode.workspace.getConfiguration("llmMobileBridge").get<boolean>("autoStart", true);
  if (autoStart && vscode.workspace.isTrusted) await controller.start();
}

export function deactivate(): void {}

async function openTranscript(controller: BridgeController, ref: string, title: string): Promise<void> {
  try {
    const { session, items } = await controller.readTimeline(ref);
    const panel = vscode.window.createWebviewPanel(
      "llmMobileBridge.transcript",
      title,
      vscode.ViewColumn.Active,
      { enableScripts: false },
    );
    panel.webview.html = renderTranscript(session, items);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await vscode.window.showErrorMessage(`Не удалось открыть транскрипт: ${message}`);
  }
}

function renderTranscript(session: SessionDescriptor, items: TimelineItem[]): string {
  const rows = items.map((item) => {
    const label = item.role ?? item.kind;
    const cls = item.role === "user" ? "user" : item.kind;
    const text = escapeHtml(item.text ?? item.status ?? "");
    const body = item.kind === "tool" ? `<pre>${text}</pre>` : `<p>${text.replaceAll("\n", "<br>")}</p>`;
    return `<section class="item ${cls}"><header>${escapeHtml(label.toUpperCase())}</header>${body}</section>`;
  }).join("\n");
  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family); padding: 12px 16px; max-width: 900px; }
  h2 { margin-bottom: 2px; }
  .meta { color: var(--vscode-descriptionForeground); margin-bottom: 16px; }
  .item { border: 1px solid var(--vscode-widget-border, #444); border-radius: 8px; padding: 8px 12px; margin-bottom: 10px; }
  .item.user { border-color: var(--vscode-focusBorder); }
  .item.reasoning { opacity: 0.75; }
  .item header { font-size: 11px; letter-spacing: 0.06em; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
  pre { white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family); font-size: 12px; margin: 0; }
  p { margin: 0; white-space: pre-wrap; word-break: break-word; }
</style></head><body>
<h2>${escapeHtml(session.title ?? "Транскрипт")}</h2>
<div class="meta">${escapeHtml([session.provider, session.project, session.state].filter(Boolean).join(" · "))}</div>
${rows || "<p>Пустой транскрипт.</p>"}
</body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatWhen(timestamp?: number): string | undefined {
  if (!timestamp) return undefined;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return undefined;
  const now = Date.now();
  const days = Math.floor((now - timestamp) / 86_400_000);
  if (days <= 0) return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (days === 1) return "вчера";
  if (days < 7) return `${days} дн. назад`;
  return date.toLocaleDateString();
}

function createToken(): string {
  return randomBytes(32).toString("base64url");
}

function buildMobileUrl(url: string, port: number): string {
  try {
    const parsed = new URL(url);
    // Only sync the port for the local development hosts; a custom domain
    // (e.g. a wss:// reverse proxy) is used exactly as configured.
    const localHosts = new Set(["10.0.2.2", "127.0.0.1", "localhost"]);
    if (parsed.protocol === "ws:" && localHosts.has(parsed.hostname)) {
      parsed.port = String(port);
    }
    return parsed.toString();
  } catch {
    return `ws://10.0.2.2:${port}`;
  }
}
