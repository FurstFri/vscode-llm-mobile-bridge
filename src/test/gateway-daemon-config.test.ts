import assert from "node:assert/strict";
import test from "node:test";
import { createPairingToken, parseGatewayDaemonConfig } from "../gateway-daemon-config.js";

const TOKEN = "a".repeat(32);

test("daemon config is secure by default", () => {
  const config = parseGatewayDaemonConfig({ BRIDGE_TOKEN: TOKEN }, []);

  assert.equal(config.command, "serve");
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 8765);
  assert.equal(config.mobileUrl, "ws://10.0.2.2:8765/");
  assert.equal(config.enableClaude, true);
  assert.equal(config.enableCodex, true);
  assert.equal(config.allowTurns, false);
});

test("daemon config rejects missing or weak pairing credentials", () => {
  assert.throws(() => parseGatewayDaemonConfig({}, ["serve"]), /BRIDGE_TOKEN/);
  assert.throws(() => parseGatewayDaemonConfig({ BRIDGE_TOKEN: "too-short" }, ["health"]), /BRIDGE_TOKEN/);
  assert.doesNotThrow(() => parseGatewayDaemonConfig({}, ["token"]));
});

test("daemon config accepts provider controls and validates network values", () => {
  const config = parseGatewayDaemonConfig({
    BRIDGE_TOKEN: TOKEN,
    BRIDGE_HOST: "127.0.0.1",
    BRIDGE_PORT: "9876",
    BRIDGE_MOBILE_URL: "wss://bridge.example.test/mobile",
    BRIDGE_ENABLE_CLAUDE: "0",
    BRIDGE_ENABLE_CODEX: "false",
    BRIDGE_CODEX_CWD: "C:\\work\\project",
  }, ["pairing"]);

  assert.equal(config.command, "pairing");
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 9876);
  assert.equal(config.mobileUrl, "wss://bridge.example.test/mobile");
  assert.equal(config.enableClaude, false);
  assert.equal(config.enableCodex, false);
  assert.equal(config.codexCwd, "C:\\work\\project");
  assert.throws(() => parseGatewayDaemonConfig({ BRIDGE_TOKEN: TOKEN, BRIDGE_PORT: "70000" }), /BRIDGE_PORT/);
  assert.throws(
    () => parseGatewayDaemonConfig({ BRIDGE_TOKEN: TOKEN, BRIDGE_MOBILE_URL: "https://example.test" }),
    /BRIDGE_MOBILE_URL/,
  );
});

test("generated pairing tokens have 256 bits encoded as base64url", () => {
  const token = createPairingToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
});
