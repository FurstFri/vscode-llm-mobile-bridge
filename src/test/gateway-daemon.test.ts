import assert from "node:assert/strict";
import test from "node:test";
import { checkGatewayHealth } from "../gateway-daemon.js";
import { GatewayCore } from "../gateway/gateway-core.js";
import { LocalGatewayServer } from "../transport/local-gateway-server.js";

test("daemon healthcheck authenticates and receives pong", async () => {
  const token = "health-token-0123456789abcdef012345";
  const server = new LocalGatewayServer({ gateway: new GatewayCore([]), token, port: 0 });
  const port = await server.start();

  try {
    await assert.doesNotReject(() => checkGatewayHealth(`ws://127.0.0.1:${port}`, token));
    await assert.rejects(
      () => checkGatewayHealth(`ws://127.0.0.1:${port}`, "wrong-token-0123456789abcdef012345"),
      /AUTH_FAILED/,
    );
  } finally {
    await server.stop();
  }
});
