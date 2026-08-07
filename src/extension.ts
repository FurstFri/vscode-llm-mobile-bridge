import { randomBytes, randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import * as vscode from "vscode";
import { GatewayCore } from "./gateway/gateway-core.js";
import { SessionRegistry } from "./gateway/session-registry.js";
import type { SessionDescriptor, TimelineItem } from "./gateway/protocol.js";
import { ClaudeReadOnlyAdapter, type ClaudePermissionMode } from "./providers/claude-adapter.js";
import { CodexReadOnlyAdapter } from "./providers/codex-adapter.js";
import { encodeQr, qrToSvg } from "./qr.js";
import { DEFAULT_DISCOVERY_PORT, DiscoveryResponder } from "./transport/discovery.js";
import { LocalGatewayServer } from "./transport/local-gateway-server.js";
import { RelayHostClient } from "./transport/relay-host-client.js";

/**
 * The token used to be a single flat secret. It is now keyed by a connection
 * id so rotating one pairing cannot invalidate another, and so the phone can
 * address this machine by a stable identifier instead of by URL.
 */
const LEGACY_SECRET_KEY = "llmMobileBridge.pairingToken";
const TOKEN_SECRET_PREFIX = "llmMobileBridge.pairingToken";
/**
 * Machine-scoped, not window-scoped: the gateway serves this machine's whole
 * session store, and exactly one window hosts it while the others stand by,
 * so every window has to hand out the same identity.
 */
const CONNECTION_ID_KEY = "llmMobileBridge.connectionId";
/** Keeps session references stable across gateway restarts. */
const REF_SALT_KEY = "llmMobileBridge.sessionRefSalt";

class BridgeController implements vscode.Disposable {
  private server?: LocalGatewayServer;
  private relayClient?: RelayHostClient;
  private gateway?: GatewayCore;
  private discovery?: DiscoveryResponder;
  private activePort?: number;
  private takeoverTimer?: NodeJS.Timeout;
  private healthTimer?: NodeJS.Timeout;
  private refSalt?: string;
  /** True when a Remote-SSH window fell back to running us on this machine. */
  runningLocallyInRemoteWindow = false;

  /** Name this machine reports to the phone. */
  get machineName(): string {
    return vscode.workspace.getConfiguration("llmMobileBridge").get<string>("hostName", "").trim() || hostname();
  }
  /** An explicit stop must not be undone by the health check. */
  private stoppedByUser = false;
  private readonly status: vscode.StatusBarItem;
  readonly output: vscode.LogOutputChannel;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel("LLM Mobile Bridge", { log: true });
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.status.command = "llmMobileBridge.pairingMenu";
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
    this.stoppedByUser = false;
    const config = vscode.workspace.getConfiguration("llmMobileBridge");
    const port = config.get<number>("port", 8765);
    const token = await this.getOrCreateToken();
    this.refSalt ??= await this.getOrCreateSecret(REF_SALT_KEY);
    const gateway = this.ensureGateway(true);
    const server = new LocalGatewayServer({ gateway, token, port, host: "127.0.0.1" });
    try {
      this.activePort = await server.start();
      this.server = server;
      const relayUrl = config.get<string>("relayUrl", "").trim();
      if (relayUrl) {
        try {
          this.relayClient = new RelayHostClient({ relayUrl, token, localPort: this.activePort });
          this.relayClient.start();
          this.output.info(`Relay host client connecting to ${relayUrl}.`);
        } catch (relayError) {
          const message = relayError instanceof Error ? relayError.message : String(relayError);
          this.output.error(`Relay host client failed to start: ${message}`);
          await vscode.window.showWarningMessage(`LLM Mobile Bridge relay is misconfigured: ${message}`);
        }
      }
      this.status.text = this.relayClient ? "$(radio-tower) LLM Bridge: local+relay" : "$(radio-tower) LLM Bridge: local";
      this.status.tooltip = "Loopback gateway is running. Click to pair a phone.";
      await this.startDiscovery(config, this.activePort);
      this.output.info(`Gateway started on loopback port ${this.activePort}.`);
    } catch (error) {
      this.activePort = undefined;
      await server.stop();
      const message = error instanceof Error ? error.message : String(error);
      if (isPortInUse(error)) {
        // Another VS Code window already hosts the gateway for this machine.
        // Stay idle and take over if that window closes.
        this.setStandby(port);
        this.output.info(`Port ${port} is already served by another VS Code window; standing by.`);
        this.scheduleTakeover();
      } else {
        this.setStopped();
        this.output.error(`Gateway failed to start: ${message}`);
        await vscode.window.showErrorMessage(`LLM Mobile Bridge could not start: ${message}`);
      }
    }
    this.changeEmitter.fire();
  }

  /** Retries until this window can host the gateway (or another one does). */
  private scheduleTakeover(): void {
    if (this.takeoverTimer || this.server) return;
    this.takeoverTimer = setInterval(() => {
      if (this.server) {
        this.clearTakeover();
        return;
      }
      void this.start();
    }, 15_000);
    this.takeoverTimer.unref?.();
  }

  /**
   * Keeps the gateway alive without user action: after an extension update or
   * a crash the phone would otherwise silently lose the machine.
   */
  startHealthCheck(): void {
    const timer = setInterval(() => {
      if (this.server || this.takeoverTimer || this.stoppedByUser) return;
      const autoStart = vscode.workspace.getConfiguration("llmMobileBridge").get<boolean>("autoStart", true);
      if (autoStart && vscode.workspace.isTrusted) void this.start();
    }, 30_000);
    timer.unref?.();
    this.healthTimer = timer;
  }

  private clearTakeover(): void {
    if (!this.takeoverTimer) return;
    clearInterval(this.takeoverTimer);
    this.takeoverTimer = undefined;
  }

  async stop(explicit = false): Promise<void> {
    if (explicit) this.stoppedByUser = true;
    this.clearTakeover();
    this.discovery?.stop();
    this.discovery = undefined;
    const server = this.server;
    this.server = undefined;
    this.activePort = undefined;
    this.relayClient?.stop();
    this.relayClient = undefined;
    await server?.stop();
    this.setStopped();
    this.output.info("Gateway stopped.");
    this.changeEmitter.fire();
  }

  async copyPairing(): Promise<void> {
    const pairing = await this.pairing();
    if (!pairing) return;
    await vscode.env.clipboard.writeText(pairing.payload);
    await vscode.window.showInformationMessage("LLM Mobile Bridge pairing payload copied to the clipboard.");
  }

  /**
   * The status bar entry point. Scanning is the primary way to pair, so the QR
   * code is the first item rather than something buried in the palette.
   */
  async pairingMenu(): Promise<void> {
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: "$(device-camera) Показать QR для пейринга",
          detail: "Отсканируйте в приложении: «+ Компьютер» → «Сканировать QR»",
          run: () => this.showPairingQr(),
        },
        {
          label: "$(clippy) Скопировать пейринг",
          detail: "Вставить JSON в приложение вручную",
          run: () => this.copyPairing(),
        },
        {
          label: "$(debug-disconnect) Отключить все устройства",
          detail: "Сменить токен пейринга этой машины",
          run: () => this.disconnectAll(),
        },
      ],
      { title: "LLM Mobile Bridge", placeHolder: "Подключить телефон к этой машине" },
    );
    await choice?.run();
  }

  /**
   * Renders the pairing payload as a QR code so the phone can scan it instead
   * of the operator copying JSON between machines. The symbol is drawn locally
   * and the panel runs no scripts, so the token never leaves the workstation.
   */
  async showPairingQr(): Promise<void> {
    const pairing = await this.pairing();
    if (!pairing) return;
    const panel = vscode.window.createWebviewPanel(
      "llmMobileBridge.pairing",
      "LLM Mobile Bridge — пейринг",
      vscode.ViewColumn.Active,
      { enableScripts: false, retainContextWhenHidden: false },
    );
    const svg = qrToSvg(encodeQr(pairing.payload, "M"), {
      moduleSize: 6,
      quietZone: 4,
      dark: "#0b1220",
      light: "#ffffff",
    });
    panel.webview.html = pairingPage(svg, pairing.label, pairing.url);
  }

  async disconnectAll(): Promise<void> {
    await this.stop();
    await this.context.secrets.store(await this.tokenKey(), createToken());
    await this.start();
    await vscode.window.showInformationMessage("All mobile sessions were disconnected and the pairing token was rotated.");
  }

  /** Starts the gateway if needed and builds the payload every entry point shares. */
  private async pairing(): Promise<{ payload: string; label: string; url: string } | undefined> {
    if (!this.server || !this.activePort) await this.start();
    if (!this.server || !this.activePort) return undefined;
    const token = await this.getOrCreateToken();
    const connectionId = await this.getOrCreateConnectionId();
    const config = vscode.workspace.getConfiguration("llmMobileBridge");
    const relayUrl = config.get<string>("relayUrl", "").trim();
    const configuredUrl = config.get<string>("mobileUrl", `ws://10.0.2.2:${this.activePort}`);
    // With a relay configured, the phone connects to the relay domain as-is.
    const url = relayUrl || buildMobileUrl(configuredUrl, this.activePort);
    // The name lets the phone tell several paired machines apart; the
    // connection id lets it update that entry instead of adding a duplicate.
    const label = this.machineName;
    return {
      payload: JSON.stringify({ protocolVersion: 1, connectionId, label, url, token, name: label }),
      label,
      url,
    };
  }

  /**
   * Lets an already paired phone re-find this machine after an address change.
   * The announcement carries no credential, so answering a probe cannot pair a
   * device that was never given the token.
   */
  private async startDiscovery(config: vscode.WorkspaceConfiguration, gatewayPort: number): Promise<void> {
    if (!config.get<boolean>("discovery", true)) return;
    const responder = new DiscoveryResponder({
      connectionId: await this.getOrCreateConnectionId(),
      label: this.machineName,
      gatewayPort,
      discoveryPort: config.get<number>("discoveryPort", DEFAULT_DISCOVERY_PORT),
    });
    try {
      const port = await responder.start();
      this.discovery = responder;
      this.output.info(`Answering discovery probes on UDP ${port}.`);
    } catch (error) {
      responder.stop();
      const message = error instanceof Error ? error.message : String(error);
      this.output.warn(`Network discovery is unavailable: ${message}`);
    }
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
    if (this.healthTimer) clearInterval(this.healthTimer);
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
    const executablePath = config.get<string>("claudeExecutable", "").trim() || undefined;
    // In a Remote-SSH window the workspace lives on another machine; its path
    // means nothing to the local session stores, so ignore it entirely.
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
    const folder = workspace?.scheme === "file" ? workspace.fsPath : undefined;
    // A remote workspace here means VS Code could not run us on the remote
    // host — the extension is missing there — and fell back to this machine.
    this.runningLocallyInRemoteWindow = Boolean(workspace && !folder);
    if (this.runningLocallyInRemoteWindow) {
      this.output.warn(
        `This window is connected to a remote (${workspace?.scheme}), but the extension is running locally, `
        + "so it serves this machine's sessions. Install it on the remote host to reach that machine's chats.",
      );
    }
    const dir = scope === "workspace" ? folder : undefined;
    // New chats started from the phone run in the open workspace folder.
    const defaultCwd = folder ?? homedir();
    this.gateway = new GatewayCore(
      [
        new ClaudeReadOnlyAdapter({ dir, limit, allowTurns, permissionMode, executablePath, defaultCwd }),
        new CodexReadOnlyAdapter({ cwd: dir, limit, allowTurns, defaultCwd }),
      ],
      new SessionRegistry(this.refSalt),
      (message) => this.output.info(message),
    );
    return this.gateway;
  }

  /** Stable for the lifetime of the install, so re-pairing updates one entry. */
  private async getOrCreateConnectionId(): Promise<string> {
    const stored = this.context.globalState.get<string>(CONNECTION_ID_KEY);
    if (stored) return stored;
    const connectionId = randomUUID();
    await this.context.globalState.update(CONNECTION_ID_KEY, connectionId);
    return connectionId;
  }

  private async tokenKey(): Promise<string> {
    return `${TOKEN_SECRET_PREFIX}:${await this.getOrCreateConnectionId()}`;
  }

  private async getOrCreateToken(): Promise<string> {
    const key = await this.tokenKey();
    const stored = await this.context.secrets.get(key);
    if (stored) return stored;
    // Carry the pre-0.13 flat secret across, or every already paired phone
    // would be locked out by the upgrade alone.
    const legacy = await this.context.secrets.get(LEGACY_SECRET_KEY);
    if (legacy) {
      await this.context.secrets.store(key, legacy);
      return legacy;
    }
    return this.getOrCreateSecret(key);
  }

  private async getOrCreateSecret(key: string): Promise<string> {
    const stored = await this.context.secrets.get(key);
    if (stored) return stored;
    const value = createToken();
    await this.context.secrets.store(key, value);
    return value;
  }

  private setStopped(): void {
    this.status.text = "$(debug-disconnect) LLM Bridge: stopped";
    this.status.tooltip = "Run “LLM Mobile Bridge: Start Gateway” to enable the loopback gateway.";
  }

  private setStandby(port: number): void {
    this.status.text = "$(circle-outline) LLM Bridge: another window";
    this.status.tooltip =
      `Another VS Code window already serves the gateway on port ${port}. `
      + "This window will take over automatically if that one closes.";
  }
}

type BridgeTreeNode =
  | { kind: "status" }
  | { kind: "relay" }
  | { kind: "remoteWarning" }
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
    if (node.kind === "relay") {
      const relayUrl = vscode.workspace.getConfiguration("llmMobileBridge").get<string>("relayUrl", "").trim();
      const item = new vscode.TreeItem(
        relayUrl ? `Ретранслятор: ${relayUrl}` : "Ретранслятор не настроен — телефон не увидит эту машину",
      );
      item.iconPath = new vscode.ThemeIcon(
        relayUrl ? "cloud" : "warning",
        relayUrl ? undefined : new vscode.ThemeColor("problemsWarningIcon.foreground"),
      );
      item.description = `${this.controller.machineName}`;
      item.tooltip = relayUrl
        ? `Эта машина («${this.controller.machineName}») подключается к ретранслятору сама. `
          + "Скопируйте пейринг и добавьте её в приложении."
        : "Задайте llmMobileBridge.relayUrl. В окне Remote-SSH настройка пишется в раздел Remote — "
          + "локальное значение сюда не наследуется.";
      item.command = {
        command: "workbench.action.openSettings",
        title: "Открыть настройки",
        arguments: ["llmMobileBridge.relayUrl"],
      };
      return item;
    }
    if (node.kind === "remoteWarning") {
      const item = new vscode.TreeItem("Не установлено на сервере — показаны чаты этого ПК");
      item.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("problemsWarningIcon.foreground"));
      item.tooltip =
        "Окно подключено по Remote-SSH, но расширение там не установлено, поэтому VS Code запустил его на этом "
        + "компьютере. Нажмите, чтобы открыть Extensions и установить его на сервер.";
      item.command = {
        command: "workbench.extensions.search",
        title: "Открыть Extensions",
        arguments: ["@id:furstfri.vscode-llm-mobile-bridge"],
      };
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
            { kind: "action", label: "Показать QR для телефона", icon: "device-camera", command: "llmMobileBridge.showPairingQr" },
            { kind: "action", label: "Скопировать пейринг для телефона", icon: "device-mobile", command: "llmMobileBridge.copyPairing" },
            { kind: "action", label: "Остановить шлюз", icon: "debug-stop", command: "llmMobileBridge.stop" },
            { kind: "action", label: "Отключить все устройства", icon: "circle-slash", command: "llmMobileBridge.disconnectAll" },
          ]
        : [{ kind: "action", label: "Запустить шлюз", icon: "play", command: "llmMobileBridge.start" }];
      return [
        { kind: "status" },
        { kind: "relay" },
        ...(this.controller.runningLocallyInRemoteWindow ? [{ kind: "remoteWarning" as const }] : []),
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
    vscode.commands.registerCommand("llmMobileBridge.stop", () => controller.stop(true)),
    vscode.commands.registerCommand("llmMobileBridge.copyPairing", () => controller.copyPairing()),
    vscode.commands.registerCommand("llmMobileBridge.showPairingQr", () => controller.showPairingQr()),
    vscode.commands.registerCommand("llmMobileBridge.pairingMenu", () => controller.pairingMenu()),
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
  controller.startHealthCheck();
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

/** Static markup only: no scripts, no remote resources, no token in the text. */
function pairingPage(svg: string, label: string, url: string): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); text-align: center; padding: 24px; }
  figure { display: inline-block; margin: 0; padding: 16px; background: #ffffff; border-radius: 12px; }
  h1 { font-size: 1.1rem; margin: 0 0 4px; }
  p { margin: 4px 0; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<h1>${escapeHtml(label)}</h1>
<p>${escapeHtml(url)}</p>
<figure>${svg}</figure>
<p>Отсканируйте в приложении: «+ Компьютер» → «Сканировать QR».</p>
<p>Код содержит токен пейринга этой машины — обращайтесь с ним как с паролем.</p>
</body>
</html>`;
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

function isPortInUse(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EADDRINUSE";
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
