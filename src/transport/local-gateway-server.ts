import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type { GatewayCore } from "../gateway/gateway-core.js";
import { MOBILE_PROTOCOL_VERSION, type MobileRequest, type MobileResponse } from "./mobile-protocol.js";

export interface LocalGatewayServerOptions {
  gateway: GatewayCore;
  token: string;
  host?: string;
  port?: number;
}

export class LocalGatewayServer {
  private server?: WebSocketServer;
  private readonly authorized = new WeakSet<WebSocket>();
  private readonly owners = new WeakMap<WebSocket, string>();
  private readonly gateway: GatewayCore;
  private readonly token: string;
  private readonly host: string;
  private readonly requestedPort: number;

  constructor(options: LocalGatewayServerOptions) {
    this.gateway = options.gateway;
    this.token = options.token;
    this.host = options.host ?? "127.0.0.1";
    this.requestedPort = options.port ?? 8765;
  }

  async start(): Promise<number> {
    if (this.server) throw new Error("Gateway server is already running");
    const server = new WebSocketServer({
      host: this.host,
      port: this.requestedPort,
      maxPayload: 2 * 1024 * 1024,
      perMessageDeflate: false,
    });
    this.server = server;
    server.on("connection", (socket) => {
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          this.sendError(socket, "unknown", "INVALID_REQUEST", "Binary frames are not supported.");
          return;
        }
        void this.handleMessage(socket, data.toString("utf8"));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("Gateway did not bind a TCP port");
    return address.port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    for (const client of server.clients) client.close(1001, "Gateway stopped");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handleMessage(socket: WebSocket, raw: string): Promise<void> {
    const request = parseRequest(raw);
    if (!request) {
      this.sendError(socket, "unknown", "INVALID_REQUEST", "The request envelope is invalid.");
      return;
    }
    if (request.type === "auth") {
      if (!tokensEqual(request.token, this.token)) {
        this.sendError(socket, request.id, "AUTH_FAILED", "Pairing credentials were rejected.");
        socket.close(1008, "Authentication failed");
        return;
      }
      this.authorized.add(socket);
      this.send(socket, { protocolVersion: 1, id: request.id, ok: true, type: "auth.ready" });
      return;
    }
    if (!this.authorized.has(socket)) {
      this.sendError(socket, request.id, "AUTH_REQUIRED", "Authenticate before requesting session data.");
      return;
    }

    try {
      if (request.type === "ping") {
        this.send(socket, { protocolVersion: 1, id: request.id, ok: true, type: "pong" });
      } else if (request.type === "session.list") {
        const event = await this.gateway.listSessions(request.id);
        this.send(socket, { protocolVersion: 1, id: request.id, ok: true, type: "event", event });
      } else if (request.type === "turn.start") {
        const owner = this.ownerFor(socket);
        const options = { model: request.model, effort: request.effort };
        for await (const event of this.gateway.startTurn(request.sessionRef, owner, request.text, request.id, options)) {
          this.send(socket, { protocolVersion: 1, id: request.id, ok: true, type: "event", event });
        }
        this.send(socket, { protocolVersion: 1, id: request.id, ok: true, type: "turn.end" });
      } else if (request.type === "session.new") {
        const owner = this.ownerFor(socket);
        const options = { model: request.model, effort: request.effort };
        for await (const event of this.gateway.startNewSession(request.provider, owner, request.text, request.id, options)) {
          this.send(socket, { protocolVersion: 1, id: request.id, ok: true, type: "event", event });
        }
        this.send(socket, { protocolVersion: 1, id: request.id, ok: true, type: "turn.end" });
      } else {
        const event = await this.gateway.readSnapshot(request.sessionRef, request.id);
        this.send(socket, { protocolVersion: 1, id: request.id, ok: true, type: "event", event });
      }
    } catch {
      this.sendError(socket, request.id, "INTERNAL_ERROR", "The gateway could not complete this request.");
    }
  }

  private ownerFor(socket: WebSocket): string {
    let owner = this.owners.get(socket);
    if (!owner) {
      owner = `mobile-${randomUUID()}`;
      this.owners.set(socket, owner);
    }
    return owner;
  }

  private sendError(
    socket: WebSocket,
    id: string,
    code: Extract<MobileResponse, { ok: false }>["error"]["code"],
    message: string,
  ): void {
    this.send(socket, { protocolVersion: 1, id, ok: false, type: "error", error: { code, message } });
  }

  private send(socket: WebSocket, response: MobileResponse): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(response));
  }
}

function parseRequest(raw: string): MobileRequest | undefined {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.protocolVersion !== MOBILE_PROTOCOL_VERSION || typeof value.id !== "string") return undefined;
    if (value.type === "auth" && typeof value.token === "string") return value as MobileRequest;
    if (value.type === "ping" || value.type === "session.list") return value as MobileRequest;
    if (value.type === "session.snapshot" && typeof value.sessionRef === "string") return value as MobileRequest;
    if (value.type === "turn.start" && typeof value.sessionRef === "string" && typeof value.text === "string") {
      return value as MobileRequest;
    }
    if (
      value.type === "session.new"
      && (value.provider === "claude" || value.provider === "codex")
      && typeof value.text === "string"
    ) {
      return value as MobileRequest;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function tokensEqual(received: string, expected: string): boolean {
  const left = Buffer.from(received, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
