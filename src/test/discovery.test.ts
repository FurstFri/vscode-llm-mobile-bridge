import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import test from "node:test";
import {
  DiscoveryResponder,
  isDiscoveryProbe,
  parseAnnouncement,
} from "../transport/discovery.js";

test("answers a probe with an address but never with a credential", async () => {
  const responder = new DiscoveryResponder({
    connectionId: "window-1",
    label: "vscode-llm-mobile-bridge",
    gatewayPort: 8765,
    discoveryPort: 0,
    host: "127.0.0.1",
  });
  const discoveryPort = await responder.start();
  const client = createSocket("udp4");

  try {
    const reply = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("no announcement")), 2_000);
      client.once("message", (data) => {
        clearTimeout(timeout);
        resolve(data.toString("utf8"));
      });
      client.bind(0, "127.0.0.1", () => {
        client.send(
          JSON.stringify({ llmMobileBridge: 1, probe: true }),
          discoveryPort,
          "127.0.0.1",
        );
      });
    });

    const announcement = parseAnnouncement(reply);
    assert.deepEqual(announcement, {
      llmMobileBridge: 1,
      connectionId: "window-1",
      label: "vscode-llm-mobile-bridge",
      port: 8765,
    });
    assert.equal(/token/i.test(reply), false, "an announcement must not carry the pairing token");
  } finally {
    client.close();
    responder.stop();
  }
});

test("ignores traffic that is not a probe", () => {
  assert.equal(isDiscoveryProbe(JSON.stringify({ llmMobileBridge: 1, probe: true })), true);
  for (const noise of [
    "",
    "not json",
    JSON.stringify({ probe: true }),
    JSON.stringify({ llmMobileBridge: 2, probe: true }),
    JSON.stringify({ llmMobileBridge: 1 }),
  ]) {
    assert.equal(isDiscoveryProbe(noise), false, `for ${noise}`);
  }
});

test("rejects malformed announcements instead of pairing against them", () => {
  for (const noise of [
    "{}",
    "broken",
    JSON.stringify({ llmMobileBridge: 1, connectionId: "", port: 1 }),
    JSON.stringify({ llmMobileBridge: 1, connectionId: "a", port: 0 }),
    JSON.stringify({ llmMobileBridge: 1, connectionId: "a", port: "8765" }),
    JSON.stringify({ llmMobileBridge: 9, connectionId: "a", port: 8765 }),
  ]) {
    assert.equal(parseAnnouncement(noise), undefined, `for ${noise}`);
  }
  assert.deepEqual(
    parseAnnouncement(JSON.stringify({ llmMobileBridge: 1, connectionId: "a", port: 8765 })),
    { llmMobileBridge: 1, connectionId: "a", label: "", port: 8765 },
  );
});

test("stops cleanly and can be started again on a fresh port", async () => {
  const responder = new DiscoveryResponder({
    connectionId: "window-1",
    label: "one",
    gatewayPort: 8765,
    discoveryPort: 0,
    host: "127.0.0.1",
  });

  await responder.start();
  responder.stop();
  responder.stop();
  await responder.start();
  responder.stop();
});
