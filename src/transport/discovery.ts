import { createSocket, type Socket } from "node:dgram";

/**
 * Answers broadcast probes from the phone so it can find this window without
 * anyone typing an address. The reply deliberately carries no token: it only
 * says where a gateway lives, which lets an already paired device repair a
 * stale host or port on its own.
 */
export const DISCOVERY_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_DISCOVERY_PORT = 8766;

export interface DiscoveryAnnouncement {
  llmMobileBridge: 1;
  connectionId: string;
  label: string;
  port: number;
}

export interface DiscoveryResponderOptions {
  connectionId: string;
  label: string;
  /** Port the mobile gateway listens on, sent so the phone can reach it. */
  gatewayPort: number;
  discoveryPort?: number;
  host?: string;
}

export function isDiscoveryProbe(raw: string): boolean {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return value.llmMobileBridge === DISCOVERY_PROTOCOL_VERSION && value.probe === true;
  } catch {
    return false;
  }
}

export function parseAnnouncement(raw: string): DiscoveryAnnouncement | undefined {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.llmMobileBridge !== DISCOVERY_PROTOCOL_VERSION) return undefined;
    if (typeof value.connectionId !== "string" || !value.connectionId) return undefined;
    if (typeof value.port !== "number" || !Number.isInteger(value.port) || value.port <= 0) return undefined;
    return {
      llmMobileBridge: DISCOVERY_PROTOCOL_VERSION,
      connectionId: value.connectionId,
      label: typeof value.label === "string" ? value.label : "",
      port: value.port,
    };
  } catch {
    return undefined;
  }
}

export class DiscoveryResponder {
  private socket?: Socket;
  private readonly announcement: string;
  private readonly discoveryPort: number;
  private readonly host: string;

  constructor(options: DiscoveryResponderOptions) {
    this.announcement = JSON.stringify({
      llmMobileBridge: DISCOVERY_PROTOCOL_VERSION,
      connectionId: options.connectionId,
      label: options.label,
      port: options.gatewayPort,
    } satisfies DiscoveryAnnouncement);
    this.discoveryPort = options.discoveryPort ?? DEFAULT_DISCOVERY_PORT;
    this.host = options.host ?? "0.0.0.0";
  }

  async start(): Promise<number> {
    if (this.socket) throw new Error("Discovery responder is already running");
    const socket = createSocket({ type: "udp4", reuseAddr: true });
    this.socket = socket;
    socket.on("message", (data, sender) => {
      if (!isDiscoveryProbe(data.toString("utf8"))) return;
      socket.send(this.announcement, sender.port, sender.address);
    });
    socket.on("error", () => {
      // A discovery failure must never take the gateway down with it.
      this.stop();
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(this.discoveryPort, this.host, () => {
        socket.off("error", reject);
        resolve();
      });
    });
    socket.setBroadcast(true);
    const address = socket.address();
    return typeof address === "string" ? this.discoveryPort : address.port;
  }

  stop(): void {
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) return;
    try {
      socket.close();
    } catch {
      // Already closed by the runtime.
    }
  }
}
