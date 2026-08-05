import assert from "node:assert/strict";
import test from "node:test";
import type {
  GetSessionInfoOptions,
  GetSessionMessagesOptions,
  ListSessionsOptions,
  Options,
  SDKMessage,
  SDKSessionInfo,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeReadOnlyAdapter,
  parseUserQuestion,
  type ClaudeSessionSource,
} from "../providers/claude-adapter.js";

const sessionInfo: SDKSessionInfo = {
  sessionId: "private-claude-session",
  summary: "Generated summary",
  customTitle: "Chosen title",
  lastModified: 1234,
  fileSize: 5678,
  cwd: "C:/private/workspace",
};

const messages: SessionMessage[] = [
  {
    type: "user",
    uuid: "user-1",
    session_id: sessionInfo.sessionId,
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: { role: "user", content: "Inspect the project" },
  },
  {
    type: "assistant",
    uuid: "assistant-1",
    session_id: sessionInfo.sessionId,
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "I should inspect safely." },
        { type: "text", text: "I will inspect it." },
        { type: "tool_use", id: "tool-1", name: "Read", input: {} },
      ],
    },
  },
  {
    type: "user",
    uuid: "tool-result-1",
    session_id: sessionInfo.sessionId,
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool-1", content: "read complete" }],
    },
  },
];

test("lists Claude sessions with metadata without exposing workspace paths", async () => {
  const calls: ListSessionsOptions[] = [];
  const adapter = new ClaudeReadOnlyAdapter({
    dir: "C:/private/workspace",
    limit: 10,
    source: source({
      listSessions: async (options) => {
        calls.push(options ?? {});
        return [sessionInfo];
      },
    }),
  });

  const sessions = await adapter.listSessions();

  assert.deepEqual(calls, [{ dir: "C:/private/workspace", limit: 10 }]);
  assert.deepEqual(sessions, [{
    providerSessionId: sessionInfo.sessionId,
    title: "Chosen title",
    project: "workspace",
    updatedAt: 1234,
    capabilities: { canRead: true, canStartTurn: true, canApprove: false },
  }]);
  assert.equal(JSON.stringify(sessions).includes(sessionInfo.cwd ?? ""), false);
});

test("lists sessions across all projects when no directory filter is set", async () => {
  const calls: ListSessionsOptions[] = [];
  const adapter = new ClaudeReadOnlyAdapter({
    source: source({
      listSessions: async (options) => {
        calls.push(options ?? {});
        return [sessionInfo];
      },
    }),
  });

  await adapter.listSessions();

  assert.deepEqual(calls, [{ limit: 100 }]);
});

test("startTurn resumes the session with query and streams normalized events", async () => {
  const queries: Array<{ prompt: string; options?: Options }> = [];
  const adapter = new ClaudeReadOnlyAdapter({
    source: source({
      runQuery: (params) => {
        queries.push(params);
        return streamOf([
          {
            type: "assistant",
            uuid: "assistant-2",
            session_id: sessionInfo.sessionId,
            message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
          } as unknown as SDKMessage,
          {
            type: "result",
            subtype: "success",
            is_error: false,
          } as unknown as SDKMessage,
        ]);
      },
    }),
  });

  const events = [];
  for await (const event of adapter.startTurn(sessionInfo.sessionId, "continue please")) events.push(event);

  assert.equal(queries.length, 1);
  assert.equal(queries[0]?.prompt, "continue please");
  assert.equal(queries[0]?.options?.resume, sessionInfo.sessionId);
  assert.equal(queries[0]?.options?.cwd, sessionInfo.cwd);
  const streamedItem = (events[0]?.payload as { item: Record<string, unknown> }).item;
  assert.equal(typeof streamedItem.at, "number");
  delete streamedItem.at;
  assert.deepEqual(events, [
    {
      type: "item.complete",
      payload: {
        item: { id: "assistant-2", kind: "message", role: "assistant", text: "Done.", status: "completed" },
      },
    },
    { type: "turn.status", payload: { status: "completed" } },
  ]);
});

test("maps the Claude model list with its effort levels", async () => {
  const adapter = new ClaudeReadOnlyAdapter({ source: source() });

  const models = await adapter.listModels();

  assert.deepEqual(models, [
    {
      id: "default",
      label: "Default (recommended)",
      description: "Opus",
      efforts: ["low", "high", "max"],
      isDefault: true,
    },
    { id: "haiku", label: "Haiku", description: "Fastest", efforts: [], isDefault: false },
  ]);
});

test("captures the rate limit reported during a turn", async () => {
  const adapter = new ClaudeReadOnlyAdapter({
    source: source({
      runQuery: () => streamOf([
        {
          type: "rate_limit_event",
          rate_limit_info: { status: "allowed", utilization: 62, resetsAt: 1786275247, rateLimitType: "seven_day" },
        } as unknown as SDKMessage,
      ]),
    }),
  });

  assert.deepEqual(await adapter.readLimits(), { note: "Появится после первого ответа" });
  for await (const _event of adapter.startTurn(sessionInfo.sessionId, "hi")) void _event;

  assert.deepEqual(await adapter.readLimits(), {
    usedPercent: 62,
    resetsAt: 1786275247,
    windowMinutes: 10080,
    status: "allowed",
  });
});

test("startTurn applies model and effort overrides", async () => {
  const queries: Array<{ prompt: string; options?: Options }> = [];
  const adapter = new ClaudeReadOnlyAdapter({
    source: source({
      runQuery: (params) => {
        queries.push(params);
        return streamOf([]);
      },
    }),
  });

  for await (const _event of adapter.startTurn(sessionInfo.sessionId, "hi", { model: "opus", effort: "high" })) {
    void _event;
  }

  const options = queries[0]?.options as Record<string, unknown> | undefined;
  assert.equal(options?.model, "opus");
  assert.equal(options?.effort, "high");
  assert.deepEqual(options?.thinking, { type: "adaptive" });
});

test("startTurn disables thinking when effort is off", async () => {
  const queries: Array<{ prompt: string; options?: Options }> = [];
  const adapter = new ClaudeReadOnlyAdapter({
    source: source({
      runQuery: (params) => {
        queries.push(params);
        return streamOf([]);
      },
    }),
  });

  for await (const _event of adapter.startTurn(sessionInfo.sessionId, "hi", { effort: "off" })) void _event;

  const options = queries[0]?.options as Record<string, unknown> | undefined;
  assert.deepEqual(options?.thinking, { type: "disabled" });
  assert.equal(options?.effort, undefined);
});

test("startNewSession announces the session id from the first stream message", async () => {
  const queries: Array<{ prompt: string; options?: Options }> = [];
  const adapter = new ClaudeReadOnlyAdapter({
    defaultCwd: "C:/work/project",
    source: source({
      runQuery: (params) => {
        queries.push(params);
        return streamOf([
          {
            type: "assistant",
            uuid: "assistant-new",
            session_id: "fresh-session",
            message: { role: "assistant", content: [{ type: "text", text: "Начал." }] },
          } as unknown as SDKMessage,
        ]);
      },
    }),
  });

  const events = [];
  for await (const event of adapter.startNewSession("сделай проект")) events.push(event);

  assert.equal(queries[0]?.options?.resume, undefined);
  assert.equal(queries[0]?.options?.cwd, "C:/work/project");
  assert.equal(events[0]?.type, "session.new");
  const announced = events[0]?.payload as { providerSessionId: string; project?: string; title?: string };
  assert.equal(announced.providerSessionId, "fresh-session");
  assert.equal(announced.project, "project");
  assert.equal(announced.title, "сделай проект");
  assert.equal(events[1]?.type, "item.complete");
});

test("forwards a permission prompt to the phone and applies the answer", async () => {
  let decide: ((result: unknown) => void) | undefined;
  const adapter = new ClaudeReadOnlyAdapter({
    permissionMode: "askOnPhone",
    source: source({
      runQuery: (params) => {
        // The SDK asks while its stream is being consumed.
        const canUseTool = (params.options as Record<string, unknown>).canUseTool as
          (name: string, input: Record<string, unknown>, options: { signal: AbortSignal }) => Promise<unknown>;
        const asked = canUseTool("Bash", { command: "rm -rf build" }, { signal: new AbortController().signal });
        return (async function* () {
          decide = (result) => void result;
          const verdict = await asked;
          yield {
            type: "assistant",
            uuid: "assistant-1",
            session_id: sessionInfo.sessionId,
            message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(verdict) }] },
          } as unknown as SDKMessage;
        })();
      },
    }),
  });

  const events: Array<{ type: string; payload: unknown }> = [];
  const iterator = adapter.startTurn(sessionInfo.sessionId, "почисти сборку")[Symbol.asyncIterator]();

  const first = await iterator.next();
  assert.equal(first.value?.type, "approval.request");
  const asked = first.value?.payload as { id: string; toolName: string; summary: string; resolved: boolean };
  assert.equal(asked.toolName, "Bash");
  assert.equal(asked.summary, "rm -rf build");
  assert.equal(asked.resolved, false);

  assert.equal(adapter.resolveApproval(asked.id, true), true);
  // A second answer for the same prompt is ignored.
  assert.equal(adapter.resolveApproval(asked.id, true), false);

  for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
    events.push(next.value as { type: string; payload: unknown });
  }
  void decide;

  const resolved = events.find((event) => event.type === "approval.request");
  assert.deepEqual(resolved?.payload, { id: asked.id, toolName: "Bash", resolved: true, allow: true });
  const reply = events.find((event) => event.type === "item.complete");
  assert.match(JSON.stringify(reply?.payload), /"behavior\\":\\"allow/);
});

test("recognises the agent's question and its options", () => {
  const parsed = parseUserQuestion("AskUserQuestion", {
    questions: [{
      question: "Куда деплоить?",
      header: "Цель",
      multiSelect: false,
      options: [{ label: "staging", description: "тест" }, { label: "prod" }],
    }],
  });

  assert.deepEqual(parsed, {
    question: "Куда деплоить?",
    options: ["staging", "prod"],
    multiSelect: false,
  });
  assert.equal(parseUserQuestion("Bash", { command: "ls" }), undefined);
});

test("intercepts AskUserQuestion via the PreToolUse hook", async () => {
  let hook: ((input: unknown, id: string | undefined, opts: { signal: AbortSignal }) => Promise<unknown>) | undefined;
  const adapter = new ClaudeReadOnlyAdapter({
    permissionMode: "askOnPhone",
    source: source({
      runQuery: (params) => {
        // AskUserQuestion skips canUseTool: the SDK invokes the PreToolUse
        // hook we register on the "AskUserQuestion" matcher instead.
        const hooks = (params.options as { hooks?: Record<string, Array<{ hooks: Array<typeof hook> }>> }).hooks;
        hook = hooks?.PreToolUse?.at(-1)?.hooks?.[0];
        return (async function* () {
          if (!hook) throw new Error("hook not registered");
          const result = await hook(
            {
              hook_event_name: "PreToolUse",
              tool_name: "AskUserQuestion",
              tool_input: { questions: [{ question: "Куда?", options: [{ label: "staging" }, { label: "prod" }] }] },
              tool_use_id: "tu_1",
            },
            "tu_1",
            { signal: new AbortController().signal },
          ) as { hookSpecificOutput?: { permissionDecisionReason?: string } };
          yield {
            type: "assistant",
            uuid: "assistant-hook",
            session_id: sessionInfo.sessionId,
            message: { role: "assistant", content: [{ type: "text", text: result.hookSpecificOutput?.permissionDecisionReason ?? "" }] },
          } as unknown as SDKMessage;
        })();
      },
    }),
  });

  const iterator = adapter.startTurn(sessionInfo.sessionId, "куда")[Symbol.asyncIterator]();
  const first = await iterator.next();
  const asked = first.value?.payload as { id: string; kind: string; options: string[] };
  assert.equal(asked.kind, "question");
  assert.equal(adapter.resolveApproval(asked.id, true, undefined, "prod"), true);

  const seen: string[] = [];
  for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
    seen.push(JSON.stringify(next.value?.payload ?? {}));
  }
  assert.ok(seen.some((entry) => entry.includes("Пользователь ответил: prod")));
});

test("a denied tool call reaches the model as a plain permission denial", async () => {
  const adapter = new ClaudeReadOnlyAdapter({
    permissionMode: "askOnPhone",
    source: source({
      runQuery: (params) => {
        const canUseTool = (params.options as Record<string, unknown>).canUseTool as
          (name: string, input: Record<string, unknown>, options: { signal: AbortSignal }) => Promise<{
            behavior: string; message?: string;
          }>;
        const asked = canUseTool("Bash", { command: "rm -rf build" }, { signal: new AbortController().signal });
        return (async function* () {
          const verdict = await asked;
          yield {
            type: "assistant",
            uuid: "assistant-denied",
            session_id: sessionInfo.sessionId,
            message: { role: "assistant", content: [{ type: "text", text: verdict.message ?? "" }] },
          } as unknown as SDKMessage;
        })();
      },
    }),
  });

  const iterator = adapter.startTurn(sessionInfo.sessionId, "снеси всё")[Symbol.asyncIterator]();
  const first = await iterator.next();
  const asked = first.value?.payload as { id: string; kind: string };
  assert.equal(asked.kind, "permission");
  assert.equal(adapter.resolveApproval(asked.id, false, "не надо"), true);

  const seen: string[] = [];
  for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
    seen.push(JSON.stringify(next.value?.payload ?? {}));
  }
  assert.ok(seen.some((entry) => entry.includes("не надо")));
});

test("startTurn is rejected when sending is disabled", async () => {
  const adapter = new ClaudeReadOnlyAdapter({ allowTurns: false, source: source() });
  const sessions = await adapter.listSessions();
  assert.equal(sessions[0]?.capabilities?.canStartTurn, false);
  await assert.rejects(async () => {
    for await (const _event of adapter.startTurn(sessionInfo.sessionId, "hi")) void _event;
  });
});

test("normalizes Claude transcript text, reasoning, and completed tool use", async () => {
  const adapter = new ClaudeReadOnlyAdapter({ source: source() });

  const snapshot = await adapter.readSnapshot(sessionInfo.sessionId);

  assert.equal(snapshot.revision, "1234:5678:tool-result-1");
  assert.equal(snapshot.state, "idle");
  assert.deepEqual(snapshot.items, [
    {
      id: "user-1",
      kind: "message",
      role: "user",
      text: "Inspect the project",
      status: "completed",
    },
    {
      id: "assistant-1:thinking:0",
      kind: "reasoning",
      text: "I should inspect safely.",
      status: "completed",
    },
    {
      id: "assistant-1",
      kind: "message",
      role: "assistant",
      text: "I will inspect it.",
      status: "completed",
    },
    {
      id: "tool-1",
      kind: "tool",
      text: "Read\nread complete",
      status: "completed",
    },
  ]);
});

function source(overrides: Partial<ClaudeSessionSource> = {}): ClaudeSessionSource {
  return {
    listSessions: async (_options?: ListSessionsOptions) => [sessionInfo],
    getSessionInfo: async (_sessionId: string, _options?: GetSessionInfoOptions) => sessionInfo,
    getSessionMessages: async (_sessionId: string, _options?: GetSessionMessagesOptions) => messages,
    runQuery: () => streamOf([]),
    listModels: async () => [
      { value: "default", displayName: "Default (recommended)", description: "Opus", supportedEffortLevels: ["low", "high", "max"] },
      { value: "haiku", displayName: "Haiku", description: "Fastest" },
    ],
    ...overrides,
  };
}

async function* streamOf(values: SDKMessage[]): AsyncIterable<SDKMessage> {
  for (const value of values) yield value;
}
