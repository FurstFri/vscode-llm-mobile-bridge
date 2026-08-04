import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { GatewayCore } from "../gateway/gateway-core.js";
import type { ProviderAdapter, ProviderTurnEvent } from "../gateway/provider-adapter.js";
import { RelayServer } from "../relay/relay-server.js";
import { LocalGatewayServer } from "../transport/local-gateway-server.js";
import { RelayHostClient } from "../transport/relay-host-client.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

class RelayFakeAdapter implements ProviderAdapter {
  readonly provider = "claude" as const;

  async listModels() {
    return [{ id: "sonnet", label: "Sonnet", efforts: ["low"] }];
  }

  async readLimits() {
    return undefined;
  }

  async listSessions() {
    return [{
      providerSessionId: "provider-private-id",
      title: "Relayed session",
      capabilities: { canRead: true, canStartTurn: false, canApprove: false },
    }];
  }

  async readSnapshot() {
    return { revision: "1", state: "idle" as const, items: [] };
  }

  async *startTurn(): AsyncIterable<ProviderTurnEvent> {
    throw new Error("read only");
  }

  async *startNewSession(): AsyncIterable<ProviderTurnEvent> {
    throw new Error("read only");
  }
}

test("relay routes mobile frames through an outbound host without reading payloads", async () => {
  const relay = new RelayServer({ host: "127.0.0.1", port: 0 });
  const port = await relay.start();
  const host = await JsonSocket.connect(`ws://127.0.0.1:${port}`);
  const mobile = await JsonSocket.connect(`ws://127.0.0.1:${port}`);

  try {
    host.send({ relayProtocolVersion: 1, type: "host.register", token: TOKEN });
    assert.equal((await host.next()).type, "host.ready");

    mobile.send({ protocolVersion: 1, id: "auth", type: "auth", token: TOKEN });
    const opened = await host.next();
    assert.equal(opened.type, "mobile.open");
    assert.equal((await mobile.next()).type, "auth.ready");

    mobile.send({ protocolVersion: 1, id: "ping-1", type: "ping" });
    const forwarded = await host.next();
    assert.equal(forwarded.type, "mobile.request");
    assert.deepEqual(forwarded.payload, { protocolVersion: 1, id: "ping-1", type: "ping" });

    host.send({
      relayProtocolVersion: 1,
      type: "mobile.response",
      channelId: opened.channelId,
      payload: { protocolVersion: 1, id: "ping-1", ok: true, type: "pong" },
    });
    assert.deepEqual(await mobile.next(), { protocolVersion: 1, id: "ping-1", ok: true, type: "pong" });

    mobile.send({ protocolVersion: 1, id: "turn-1", type: "turn.start", sessionRef: "ref-1", text: "привет" });
    const forwardedTurn = await host.next();
    assert.equal(forwardedTurn.type, "mobile.request");
    assert.deepEqual(forwardedTurn.payload, {
      protocolVersion: 1,
      id: "turn-1",
      type: "turn.start",
      sessionRef: "ref-1",
      text: "привет",
    });
  } finally {
    host.close();
    mobile.close();
    await relay.stop();
  }
});

test("VS Code relay client bridges Android requests to the local gateway", async () => {
  const relay = new RelayServer({ host: "127.0.0.1", port: 0 });
  const relayPort = await relay.start();
  const local = new LocalGatewayServer({
    gateway: new GatewayCore([new RelayFakeAdapter()]),
    token: TOKEN,
    host: "127.0.0.1",
    port: 0,
  });
  const localPort = await local.start();
  const host = new RelayHostClient({
    relayUrl: `ws://127.0.0.1:${relayPort}`,
    token: TOKEN,
    localPort,
    reconnectDelayMs: 10,
  });
  host.start();
  await delay(30);
  const mobile = await JsonSocket.connect(`ws://127.0.0.1:${relayPort}`);

  try {
    mobile.send({ protocolVersion: 1, id: "auth", type: "auth", token: TOKEN });
    assert.equal((await mobile.next()).type, "auth.ready");
    mobile.send({ protocolVersion: 1, id: "list", type: "session.list" });
    const response = await mobile.next();
    assert.equal(response.type, "event");
    const serialized = JSON.stringify(response);
    assert.match(serialized, /Relayed session/);
    assert.equal(serialized.includes("provider-private-id"), false);
  } finally {
    mobile.close();
    host.stop();
    await local.stop();
    await relay.stop();
  }
});

class JsonSocket {
  private readonly queued: Array<Record<string, any>> = [];
  private readonly waiting: Array<(value: Record<string, any>) => void> = [];

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const value = JSON.parse(data.toString("utf8")) as Record<string, any>;
      const resolve = this.waiting.shift();
      if (resolve) resolve(value);
      else this.queued.push(value);
    });
  }

  static async connect(url: string): Promise<JsonSocket> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return new JsonSocket(socket);
  }

  send(value: unknown): void {
    this.socket.send(JSON.stringify(value));
  }

  next(timeoutMs = 2_000): Promise<Record<string, any>> {
    const queued = this.queued.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket message")), timeoutMs);
      this.waiting.push((value) => {
        clearTimeout(timeout);
        resolve(value);
      });
    });
  }

  close(): void {
    this.socket.close();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
