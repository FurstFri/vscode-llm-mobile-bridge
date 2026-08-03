import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexReadOnlyAdapter,
  type CodexSessionSource,
} from "../providers/codex-adapter.js";

const thread = {
  id: "private-codex-thread",
  name: "Codex conversation",
  preview: "private prompt preview",
  cwd: "C:\\workspace",
  updatedAt: 42,
  status: { type: "idle" },
  turns: [{
    id: "turn-1",
    status: "completed",
    items: [
      { id: "user-1", type: "userMessage", content: [{ type: "text", text: "Please inspect" }] },
      { id: "reasoning-1", type: "reasoning", summary: [{ type: "summaryText", text: "Inspect safely" }] },
      { id: "command-1", type: "commandExecution", command: "rg --files", aggregatedOutput: "README.md", status: "completed" },
      { id: "agent-1", type: "agentMessage", text: "Inspection complete" },
    ],
  }],
};

test("lists matching Codex workspace threads with metadata", async () => {
  const adapter = new CodexReadOnlyAdapter({ cwd: "C:/workspace", source: source() });

  const sessions = await adapter.listSessions();

  assert.deepEqual(sessions, [{
    providerSessionId: "private-codex-thread",
    title: "Codex conversation",
    project: "workspace",
    updatedAt: 42,
    capabilities: { canRead: true, canStartTurn: true, canApprove: false },
  }]);
  assert.equal(JSON.stringify(sessions).includes("C:\\workspace"), false);
});

test("lists all threads when no workspace filter is configured", async () => {
  const adapter = new CodexReadOnlyAdapter({ source: source() });

  const sessions = await adapter.listSessions();

  assert.equal(sessions.length, 1);
});

test("startTurn maps Codex turn notifications into gateway events", async () => {
  const turns: Array<{ threadId: string; text: string }> = [];
  const adapter = new CodexReadOnlyAdapter({
    source: source({
      runTurn: async function* (threadId, text) {
        turns.push({ threadId, text });
        yield {
          method: "item/completed",
          params: { item: { id: "agent-2", type: "agentMessage", text: "Готово" } },
        };
        yield { method: "turn/completed", params: { turn: { id: "turn-2", status: "completed" } } };
      },
    }),
  });

  const events = [];
  for await (const event of adapter.startTurn(thread.id, "продолжай")) events.push(event);

  assert.deepEqual(turns, [{ threadId: thread.id, text: "продолжай" }]);
  assert.deepEqual(events, [
    {
      type: "item.complete",
      payload: { item: { id: "agent-2", kind: "message", role: "assistant", text: "Готово", status: "completed" } },
    },
    { type: "turn.status", payload: { status: "completed" } },
  ]);
});

test("normalizes Codex turns without exposing thread metadata", async () => {
  const adapter = new CodexReadOnlyAdapter({ source: source() });

  const snapshot = await adapter.readSnapshot(thread.id);

  assert.equal(snapshot.revision, "42:turn-1:agent-1");
  assert.equal(snapshot.state, "idle");
  assert.deepEqual(snapshot.items, [
    { id: "user-1", kind: "message", role: "user", text: "Please inspect", status: "completed" },
    { id: "reasoning-1", kind: "reasoning", text: "Inspect safely", status: "completed" },
    { id: "command-1", kind: "tool", text: "rg --files\nREADME.md", status: "completed" },
    { id: "agent-1", kind: "message", role: "assistant", text: "Inspection complete", status: "completed" },
  ]);
});

function source(overrides: Partial<CodexSessionSource> = {}): CodexSessionSource {
  return {
    listThreads: async () => ({ data: [thread] }),
    readThread: async (threadId) => {
      assert.equal(threadId, thread.id);
      return { thread };
    },
    runTurn: async function* () {
      throw new Error("runTurn is not expected in this test");
    },
    ...overrides,
  };
}
