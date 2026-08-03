import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runJsonRpcSequence } from "../providers/json-rpc-client.js";

test("collects requested JSON-RPC responses from a local app-server", async () => {
  const mockServer = fileURLToPath(new URL("./mock-app-server.js", import.meta.url));
  const results = await runJsonRpcSequence(process.execPath, [mockServer], [
    { id: 1, method: "initialize" },
    { id: 2, method: "thread/list" },
  ]);

  assert.deepEqual(results.get(1)?.result, { platformOs: "windows" });
  assert.deepEqual(results.get(2)?.result, { data: [] });
});
