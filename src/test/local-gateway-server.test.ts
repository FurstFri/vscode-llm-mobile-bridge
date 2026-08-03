import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { GatewayCore } from "../gateway/gateway-core.js";
import type { ProviderAdapter, ProviderTurnEvent } from "../gateway/provider-adapter.js";
import { LocalGatewayServer } from "../transport/local-gateway-server.js";
import type { MobileRequest, MobileResponse } from "../transport/mobile-protocol.js";

class TransportFakeAdapter implements ProviderAdapter {
  readonly provider = "claude" as const;

  async listSessions() {
    return [{
      providerSessionId: "private-session-id",
      title: "Mobile test",
      capabilities: { canRead: true, canStartTurn: false, canApprove: false },
    }];
  }

  async readSnapshot() {
    return {
      revision: "snapshot-1",
      state: "idle" as const,
      items: [{ id: "message-1", kind: "message" as const, role: "assistant" as const, text: "Hello mobile" }],
    };
  }

  async *startTurn(): AsyncIterable<ProviderTurnEvent> {
    throw new Error("read only");
  }
}

test("requires authentication and serves list/snapshot over the mobile protocol", async () => {
  const gateway = new GatewayCore([new TransportFakeAdapter()]);
  const server = new LocalGatewayServer({ gateway, token: "correct-token", port: 0 });
  const port = await server.start();
  const socket = await connect(`ws://127.0.0.1:${port}`);

  try {
    const unauthorized = await exchange(socket, { protocolVersion: 1, id: "before-auth", type: "session.list" });
    assert.equal(unauthorized.ok, false);
    if (unauthorized.ok) return;
    assert.equal(unauthorized.error.code, "AUTH_REQUIRED");

    const authenticated = await exchange(socket, {
      protocolVersion: 1,
      id: "auth",
      type: "auth",
      token: "correct-token",
    });
    assert.deepEqual(authenticated, { protocolVersion: 1, id: "auth", ok: true, type: "auth.ready" });

    const listed = await exchange(socket, { protocolVersion: 1, id: "list", type: "session.list" });
    assert.equal(listed.ok, true);
    if (!listed.ok || listed.type !== "event") return;
    assert.equal(listed.event.type, "session.list");
    const payload = listed.event.payload as { sessions: Array<{ ref: string }> };
    const sessionRef = payload.sessions[0]?.ref;
    assert.ok(sessionRef);
    assert.equal(JSON.stringify(listed).includes("private-session-id"), false);

    const snapshot = await exchange(socket, {
      protocolVersion: 1,
      id: "snapshot",
      type: "session.snapshot",
      sessionRef,
    });
    assert.equal(snapshot.ok, true);
    if (!snapshot.ok || snapshot.type !== "event") return;
    assert.equal(snapshot.event.type, "session.snapshot");
    assert.equal(snapshot.event.correlationId, "snapshot");
  } finally {
    socket.close();
    await onceClosed(socket);
    await server.stop();
  }
});

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function exchange(socket: WebSocket, request: MobileRequest): Promise<MobileResponse> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString("utf8")) as MobileResponse);
      } catch (error) {
        reject(error);
      }
    });
    socket.send(JSON.stringify(request), (error) => {
      if (error) reject(error);
    });
  });
}

function onceClosed(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => socket.once("close", () => resolve()));
}
