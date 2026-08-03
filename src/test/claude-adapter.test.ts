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
    ...overrides,
  };
}

async function* streamOf(values: SDKMessage[]): AsyncIterable<SDKMessage> {
  for (const value of values) yield value;
}
