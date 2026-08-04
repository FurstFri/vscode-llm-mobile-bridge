import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import type { MobileRequest, MobileResponse } from "./mobile-protocol.js";
import { RELAY_PROTOCOL_VERSION, type HostToRelayMessage, type RelayToHostMessage } from "../relay/protocol.js";

export interface RelayHostClientOptions {
  relayUrl: string;
  token: string;
  localPort: number;
  reconnectDelayMs?: number;
}

interface LocalChannel {
  socket: WebSocket;
  authId: string;
  ready: boolean;
  pending: Array<Exclude<MobileRequest, { type: "auth" }>>;
}

export class RelayHostClient {
  private relay?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = true;
  private readonly channels = new Map<string, LocalChannel>();
  private readonly relayUrl: string;
  private readonly token: string;
  private readonly localPort: number;
  private readonly reconnectDelayMs: number;

  constructor(options: RelayHostClientOptions) {
    const relayUrl = new URL(options.relayUrl);
    if (relayUrl.protocol !== "ws:" && relayUrl.protocol !== "wss:") {
      throw new Error("Relay URL must use ws:// or wss://");
    }
    this.relayUrl = relayUrl.toString();
    this.token = options.token;
    this.localPort = options.localPort;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 2_000;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.relay?.close(1000, "VS Code host stopping");
    this.relay = undefined;
    this.closeChannels();
  }

  private connect(): void {
    if (this.stopped) return;
    const relay = new WebSocket(this.relayUrl, { perMessageDeflate: false });
    this.relay = relay;
    relay.once("open", () => {
      this.sendRelay({ relayProtocolVersion: 1, type: "host.register", token: this.token });
    });
    relay.on("message", (data, isBinary) => {
      if (isBinary) return;
      const message = parseRelayMessage(data.toString("utf8"));
      if (message) this.handleRelayMessage(message);
    });
    relay.once("close", () => {
      if (this.relay === relay) this.relay = undefined;
      this.closeChannels();
      this.scheduleReconnect();
    });
    relay.once("error", () => {
      // close triggers the bounded reconnect path; provider/session errors stay local.
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, this.reconnectDelayMs);
    this.reconnectTimer.unref?.();
  }

  private handleRelayMessage(message: RelayToHostMessage): void {
    if (message.type === "host.ready") return;
    if (message.type === "mobile.open") {
      this.openChannel(message.channelId);
    } else if (message.type === "mobile.request") {
      const channel = this.channels.get(message.channelId);
      if (!channel) {
        this.sendRelay({
          relayProtocolVersion: 1,
          type: "mobile.error",
          channelId: message.channelId,
          message: "The local gateway channel is unavailable.",
        });
      } else if (channel.ready) {
        channel.socket.send(JSON.stringify(message.payload));
      } else {
        channel.pending.push(message.payload);
      }
    } else if (message.type === "mobile.close") {
      this.closeChannel(message.channelId);
    }
  }

  private openChannel(channelId: string): void {
    this.closeChannel(channelId);
    const authId = `relay-auth-${randomUUID()}`;
    const socket = new WebSocket(`ws://127.0.0.1:${this.localPort}`, { perMessageDeflate: false });
    const channel: LocalChannel = { socket, authId, ready: false, pending: [] };
    this.channels.set(channelId, channel);

    socket.once("open", () => {
      const auth: MobileRequest = { protocolVersion: 1, id: authId, type: "auth", token: this.token };
      socket.send(JSON.stringify(auth));
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const response = parseMobileResponse(data.toString("utf8"));
      if (!response) return;
      if (response.id === authId && response.ok && response.type === "auth.ready") {
        channel.ready = true;
        for (const request of channel.pending.splice(0)) socket.send(JSON.stringify(request));
        return;
      }
      this.sendRelay({ relayProtocolVersion: 1, type: "mobile.response", channelId, payload: response });
    });
    socket.once("close", () => {
      if (this.channels.get(channelId) !== channel) return;
      this.channels.delete(channelId);
      this.sendRelay({
        relayProtocolVersion: 1,
        type: "mobile.error",
        channelId,
        message: "The local VS Code gateway disconnected.",
      });
    });
    socket.once("error", () => {
      // close reports the channel failure to the relay.
    });
  }

  private closeChannel(channelId: string): void {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    this.channels.delete(channelId);
    channel.socket.close(1000, "Relay mobile channel closed");
  }

  private closeChannels(): void {
    for (const channel of this.channels.values()) channel.socket.close(1001, "Relay disconnected");
    this.channels.clear();
  }

  private sendRelay(message: HostToRelayMessage): void {
    if (this.relay?.readyState === WebSocket.OPEN) this.relay.send(JSON.stringify(message));
  }
}

function parseRelayMessage(raw: string): RelayToHostMessage | undefined {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.relayProtocolVersion !== RELAY_PROTOCOL_VERSION || typeof value.type !== "string") return undefined;
    if (value.type === "host.ready") return value as RelayToHostMessage;
    if (
      (value.type === "mobile.open" || value.type === "mobile.close")
      && typeof value.channelId === "string"
    ) return value as RelayToHostMessage;
    if (
      value.type === "mobile.request"
      && typeof value.channelId === "string"
      && typeof value.payload === "object"
      && value.payload !== null
    ) return value as RelayToHostMessage;
    return undefined;
  } catch {
    return undefined;
  }
}

function parseMobileResponse(raw: string): MobileResponse | undefined {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      value.protocolVersion !== 1
      || typeof value.id !== "string"
      || typeof value.ok !== "boolean"
      || typeof value.type !== "string"
    ) return undefined;
    return value as MobileResponse;
  } catch {
    return undefined;
  }
}
