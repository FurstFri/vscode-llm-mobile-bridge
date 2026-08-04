import { createHash, randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type { MobileRequest, MobileResponse } from "../transport/mobile-protocol.js";
import { MOBILE_PROTOCOL_VERSION } from "../transport/mobile-protocol.js";
import { RELAY_PROTOCOL_VERSION, type HostToRelayMessage, type RelayToHostMessage } from "./protocol.js";

export interface RelayServerOptions {
  host?: string;
  port?: number;
}

interface HostConnection {
  socket: WebSocket;
  tokenHash: string;
  mobiles: Map<string, WebSocket>;
}

interface MobileConnection {
  socket: WebSocket;
  host: HostConnection;
  channelId: string;
}

export class RelayServer {
  private server?: WebSocketServer;
  private readonly hosts = new Map<string, HostConnection>();
  private readonly mobileBySocket = new WeakMap<WebSocket, MobileConnection>();
  private readonly hostBySocket = new WeakMap<WebSocket, HostConnection>();
  private readonly host: string;
  private readonly port: number;

  constructor(options: RelayServerOptions = {}) {
    this.host = options.host ?? "0.0.0.0";
    this.port = options.port ?? 8765;
  }

  async start(): Promise<number> {
    if (this.server) throw new Error("Relay server is already running");
    const server = new WebSocketServer({
      host: this.host,
      port: this.port,
      maxPayload: 2 * 1024 * 1024,
      perMessageDeflate: false,
    });
    this.server = server;
    server.on("connection", (socket) => {
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          this.sendMobileError(socket, "unknown", "INVALID_REQUEST", "Binary frames are not supported.");
          return;
        }
        this.handleMessage(socket, data.toString("utf8"));
      });
      socket.once("close", () => this.handleClose(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("Relay did not bind a TCP port");
    return address.port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    for (const client of server.clients) client.close(1001, "Relay stopped");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.hosts.clear();
  }

  private handleMessage(socket: WebSocket, raw: string): void {
    const value = parseObject(raw);
    if (!value) {
      this.sendMobileError(socket, "unknown", "INVALID_REQUEST", "The relay envelope is invalid.");
      return;
    }

    const host = this.hostBySocket.get(socket);
    if (host) {
      this.handleHostMessage(host, value);
      return;
    }
    const mobile = this.mobileBySocket.get(socket);
    if (mobile) {
      this.handleMobileMessage(mobile, value);
      return;
    }

    if (value.relayProtocolVersion === RELAY_PROTOCOL_VERSION && value.type === "host.register") {
      this.registerHost(socket, value);
      return;
    }
    if (value.protocolVersion === MOBILE_PROTOCOL_VERSION && value.type === "auth") {
      this.registerMobile(socket, value);
      return;
    }
    this.sendMobileError(socket, requestId(value), "AUTH_REQUIRED", "Authenticate before using the relay.");
  }

  private registerHost(socket: WebSocket, value: Record<string, unknown>): void {
    if (typeof value.token !== "string" || value.token.length < 32) {
      socket.close(1008, "Invalid host token");
      return;
    }
    const tokenHash = hashToken(value.token);
    const previous = this.hosts.get(tokenHash);
    if (previous) previous.socket.close(4001, "Host replaced by a newer connection");
    const host: HostConnection = { socket, tokenHash, mobiles: new Map() };
    this.hosts.set(tokenHash, host);
    this.hostBySocket.set(socket, host);
    this.sendHost(socket, { relayProtocolVersion: 1, type: "host.ready" });
  }

  private registerMobile(socket: WebSocket, value: Record<string, unknown>): void {
    const id = requestId(value);
    if (typeof value.token !== "string") {
      this.sendMobileError(socket, id, "AUTH_FAILED", "Pairing credentials were rejected.");
      socket.close(1008, "Authentication failed");
      return;
    }
    const host = this.hosts.get(hashToken(value.token));
    if (!host || host.socket.readyState !== WebSocket.OPEN) {
      this.sendMobileError(socket, id, "INTERNAL_ERROR", "The paired VS Code host is offline.");
      socket.close(1013, "Host offline");
      return;
    }
    const channelId = randomUUID();
    const mobile: MobileConnection = { socket, host, channelId };
    host.mobiles.set(channelId, socket);
    this.mobileBySocket.set(socket, mobile);
    this.sendHost(host.socket, { relayProtocolVersion: 1, type: "mobile.open", channelId });
    this.sendMobile(socket, { protocolVersion: 1, id, ok: true, type: "auth.ready" });
  }

  private handleMobileMessage(mobile: MobileConnection, value: Record<string, unknown>): void {
    const request = asForwardableMobileRequest(value);
    if (!request) {
      this.sendMobileError(mobile.socket, requestId(value), "INVALID_REQUEST", "The request envelope is invalid.");
      return;
    }
    if (mobile.host.socket.readyState !== WebSocket.OPEN) {
      this.sendMobileError(mobile.socket, request.id, "INTERNAL_ERROR", "The paired VS Code host is offline.");
      return;
    }
    this.sendHost(mobile.host.socket, {
      relayProtocolVersion: 1,
      type: "mobile.request",
      channelId: mobile.channelId,
      payload: request,
    });
  }

  private handleHostMessage(host: HostConnection, value: Record<string, unknown>): void {
    if (value.relayProtocolVersion !== RELAY_PROTOCOL_VERSION || typeof value.channelId !== "string") return;
    const mobile = host.mobiles.get(value.channelId);
    if (!mobile || mobile.readyState !== WebSocket.OPEN) return;
    if (value.type === "mobile.response" && isMobileResponse(value.payload)) {
      this.sendMobile(mobile, value.payload);
    } else if (value.type === "mobile.error") {
      const message = typeof value.message === "string" ? value.message : "The VS Code host disconnected.";
      this.sendMobileError(mobile, "unknown", "INTERNAL_ERROR", message);
      mobile.close(1011, "Host channel failed");
    }
  }

  private handleClose(socket: WebSocket): void {
    const mobile = this.mobileBySocket.get(socket);
    if (mobile) {
      mobile.host.mobiles.delete(mobile.channelId);
      if (mobile.host.socket.readyState === WebSocket.OPEN) {
        this.sendHost(mobile.host.socket, {
          relayProtocolVersion: 1,
          type: "mobile.close",
          channelId: mobile.channelId,
        });
      }
      return;
    }

    const host = this.hostBySocket.get(socket);
    if (!host) return;
    if (this.hosts.get(host.tokenHash) === host) this.hosts.delete(host.tokenHash);
    for (const mobileSocket of host.mobiles.values()) {
      if (mobileSocket.readyState === WebSocket.OPEN) {
        this.sendMobileError(mobileSocket, "unknown", "INTERNAL_ERROR", "The paired VS Code host went offline.");
        mobileSocket.close(1013, "Host offline");
      }
    }
    host.mobiles.clear();
  }

  private sendHost(socket: WebSocket, message: RelayToHostMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  private sendMobile(socket: WebSocket, message: MobileResponse): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  private sendMobileError(
    socket: WebSocket,
    id: string,
    code: Extract<MobileResponse, { ok: false }>["error"]["code"],
    message: string,
  ): void {
    this.sendMobile(socket, { protocolVersion: 1, id, ok: false, type: "error", error: { code, message } });
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function parseObject(raw: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function requestId(value: Record<string, unknown>): string {
  return typeof value.id === "string" ? value.id : "unknown";
}

function asForwardableMobileRequest(value: Record<string, unknown>): Exclude<MobileRequest, { type: "auth" }> | undefined {
  if (value.protocolVersion !== MOBILE_PROTOCOL_VERSION || typeof value.id !== "string") return undefined;
  if (value.type === "ping" || value.type === "session.list" || value.type === "provider.status") {
    return value as Exclude<MobileRequest, { type: "auth" }>;
  }
  if (value.type === "session.snapshot" && typeof value.sessionRef === "string") {
    return value as Exclude<MobileRequest, { type: "auth" }>;
  }
  if (value.type === "turn.start" && typeof value.sessionRef === "string" && typeof value.text === "string") {
    return value as Exclude<MobileRequest, { type: "auth" }>;
  }
  if (
    value.type === "session.new"
    && (value.provider === "claude" || value.provider === "codex")
    && typeof value.text === "string"
  ) {
    return value as Exclude<MobileRequest, { type: "auth" }>;
  }
  return undefined;
}

function isMobileResponse(value: unknown): value is MobileResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  return response.protocolVersion === MOBILE_PROTOCOL_VERSION
    && typeof response.id === "string"
    && typeof response.type === "string"
    && typeof response.ok === "boolean";
}
