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

test("maps the Codex model list and hides internal entries", async () => {
  const adapter = new CodexReadOnlyAdapter({ source: source() });

  const models = await adapter.listModels();

  assert.deepEqual(models, [{
    id: "gpt-5.6-sol",
    label: "GPT-5.6-Sol",
    description: "Latest frontier agentic coding model.",
    efforts: ["low", "high"],
    defaultEffort: "low",
    isDefault: true,
  }]);
});

test("maps Codex rate limits", async () => {
  const adapter = new CodexReadOnlyAdapter({ source: source() });

  const limits = await adapter.readLimits();

  assert.deepEqual(limits, {
    usedPercent: 44,
    resetsAt: 1786275247,
    windowMinutes: 10080,
    plan: "plus",
    status: "allowed",
  });
});

test("startNewSession announces the created thread before its turn events", async () => {
  const calls: Array<{ text: string; cwd?: string; model?: string }> = [];
  const adapter = new CodexReadOnlyAdapter({
    defaultCwd: "C:/work/project",
    source: source({
      runNewThread: async function* (text, options, cwd) {
        calls.push({ text, cwd, model: options?.model });
        yield { kind: "thread", threadId: "thr_new" };
        yield {
          kind: "notification",
          notification: { method: "turn/completed", params: { turn: { id: "t1", status: "completed" } } },
        };
      },
    }),
  });

  const events = [];
  for await (const event of adapter.startNewSession("создай README", { model: "gpt-5.1-codex" })) events.push(event);

  assert.deepEqual(calls, [{ text: "создай README", cwd: "C:/work/project", model: "gpt-5.1-codex" }]);
  assert.equal(events[0]?.type, "session.new");
  const announced = events[0]?.payload as { providerSessionId: string; project?: string };
  assert.equal(announced.providerSessionId, "thr_new");
  assert.equal(announced.project, "project");
  assert.deepEqual(events[1], { type: "turn.status", payload: { status: "completed" } });
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
    runNewThread: async function* () {
      throw new Error("runNewThread is not expected in this test");
    },
    listModels: async () => ({
      data: [
        {
          id: "gpt-5.6-sol",
          model: "gpt-5.6-sol",
          displayName: "GPT-5.6-Sol",
          description: "Latest frontier agentic coding model.",
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: "low",
          supportedReasoningEfforts: [
            { reasoningEffort: "low" },
            { reasoningEffort: "high" },
          ],
        },
        { id: "legacy", model: "legacy", displayName: "Legacy", hidden: true },
      ],
    }),
    readRateLimits: async () => ({
      rateLimits: {
        planType: "plus",
        primary: { usedPercent: 44, windowDurationMins: 10080, resetsAt: 1786275247 },
        spendControlReached: false,
      },
    }),
    ...overrides,
  };
}
