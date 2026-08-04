import assert from "node:assert/strict";
import test from "node:test";
import { GatewayCore } from "../gateway/gateway-core.js";
import type {
  ProviderAdapter,
  ProviderSessionSnapshot,
  ProviderTurnEvent,
  TurnOptions,
} from "../gateway/provider-adapter.js";
import type { GatewayEvent } from "../gateway/protocol.js";

class FakeAdapter implements ProviderAdapter {
  readonly provider = "codex" as const;
  readonly providerSessionId = "private-provider-thread";
  snapshot: ProviderSessionSnapshot = {
    revision: 7,
    state: "idle",
    items: [{ id: "message-1", kind: "message", role: "assistant", text: "existing context" }],
  };
  turnEvents: ProviderTurnEvent[] = [
    {
      type: "item.add",
      payload: { item: { id: "message-2", kind: "message", role: "assistant", text: "answer" } },
    },
    { type: "turn.status", payload: { status: "completed" } },
  ];
  failList = false;
  failModels = false;
  failLimits = false;
  receivedTurns: Array<{ providerSessionId: string; text: string; options?: TurnOptions }> = [];
  receivedNewSessions: Array<{ text: string; options?: TurnOptions }> = [];
  newSessionId = "private-new-thread";

  async listModels() {
    if (this.failModels) throw new Error("private model diagnostic");
    return [{ id: "gpt-test", label: "GPT Test", efforts: ["low", "high"], isDefault: true }];
  }

  async readLimits() {
    if (this.failLimits) throw new Error("private limits diagnostic");
    return { usedPercent: 44, windowMinutes: 10080, plan: "plus", status: "allowed" as const };
  }

  async listSessions() {
    if (this.failList) throw new Error("private provider diagnostic");
    return [{ providerSessionId: this.providerSessionId, title: "Test conversation" }];
  }

  async readSnapshot(providerSessionId: string): Promise<ProviderSessionSnapshot> {
    assert.equal(providerSessionId, this.providerSessionId);
    return this.snapshot;
  }

  async *startTurn(providerSessionId: string, text: string, options?: TurnOptions): AsyncIterable<ProviderTurnEvent> {
    this.receivedTurns.push({ providerSessionId, text, options });
    for (const event of this.turnEvents) yield event;
  }

  async *startNewSession(text: string, options?: TurnOptions): AsyncIterable<ProviderTurnEvent> {
    this.receivedNewSessions.push({ text, options });
    yield {
      type: "session.new",
      payload: { providerSessionId: this.newSessionId, title: "Fresh chat", project: "workspace" },
    };
    for (const event of this.turnEvents) yield event;
  }
}

test("lists stable opaque session references without exposing provider ids", async () => {
  const adapter = new FakeAdapter();
  const gateway = new GatewayCore([adapter]);

  const first = await gateway.listSessions("list-one");
  const second = await gateway.listSessions("list-two");
  const firstSession = first.payload.sessions[0];
  const secondSession = second.payload.sessions[0];

  assert.ok(firstSession);
  assert.equal(secondSession?.ref, firstSession.ref);
  assert.notEqual(firstSession.ref, adapter.providerSessionId);
  assert.equal(JSON.stringify(first).includes(adapter.providerSessionId), false);
  assert.equal(first.correlationId, "list-one");
  assert.equal(second.sequence, first.sequence + 1);
});

test("reconstructs a provider snapshot behind the public reference", async () => {
  const adapter = new FakeAdapter();
  const gateway = new GatewayCore([adapter]);
  const listed = await gateway.listSessions();
  const ref = listed.payload.sessions[0]?.ref;
  assert.ok(ref);

  const event = await gateway.readSnapshot(ref, "snapshot-request");

  assert.equal(event.type, "session.snapshot");
  assert.equal(event.correlationId, "snapshot-request");
  assert.equal(event.payload.session.revision, 7);
  assert.deepEqual(event.payload.items, adapter.snapshot.items);
  assert.equal(JSON.stringify(event).includes(adapter.providerSessionId), false);
});

test("streams a turn with one correlation id and monotonic session sequence", async () => {
  const adapter = new FakeAdapter();
  const gateway = new GatewayCore([adapter]);
  const listed = await gateway.listSessions();
  const ref = listed.payload.sessions[0]?.ref;
  assert.ok(ref);

  const events = await collect(gateway.startTurn(ref, "android-device", "continue", "turn-request"));

  assert.deepEqual(events.map((event) => event.type), [
    "session.state",
    "turn.start",
    "item.add",
    "turn.status",
    "session.state",
  ]);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5]);
  assert.ok(events.every((event) => event.correlationId === "turn-request"));
  assert.deepEqual(adapter.receivedTurns, [{
    providerSessionId: adapter.providerSessionId,
    text: "continue",
    options: undefined,
  }]);
  assert.deepEqual(events.at(-1)?.payload, { state: "idle" });
});

test("reports a known provider session offline without creating a sequence gap", async () => {
  const adapter = new FakeAdapter();
  const gateway = new GatewayCore([adapter]);
  const initial = await gateway.listSessions();
  const ref = initial.payload.sessions[0]?.ref;
  assert.ok(ref);

  adapter.failList = true;
  const offline = await gateway.listSessions();
  assert.equal(offline.payload.sessions[0]?.state, "host_offline");

  const snapshot = await gateway.readSnapshot(ref);
  assert.equal(snapshot.sequence, 1);
  assert.equal(snapshot.payload.session.state, "idle");
  assert.equal(JSON.stringify(offline).includes("private provider diagnostic"), false);
});

test("rejects an empty prompt before calling the provider", async () => {
  const adapter = new FakeAdapter();
  const gateway = new GatewayCore([adapter]);
  const listed = await gateway.listSessions();
  const ref = listed.payload.sessions[0]?.ref;
  assert.ok(ref);

  const events = await collect(gateway.startTurn(ref, "android-device", "   "));

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "error");
  assert.deepEqual(events[0]?.payload, {
    code: "EMPTY_PROMPT",
    message: "The prompt must not be empty.",
  });
  assert.deepEqual(adapter.receivedTurns, []);
});

test("enforces read-only provider capabilities before claiming a writer", async () => {
  const adapter = new FakeAdapter();
  adapter.listSessions = async () => [{
    providerSessionId: adapter.providerSessionId,
    title: "Read-only conversation",
    capabilities: { canRead: true, canStartTurn: false, canApprove: false },
  }];
  const gateway = new GatewayCore([adapter]);
  const listed = await gateway.listSessions();
  const ref = listed.payload.sessions[0]?.ref;
  assert.ok(ref);

  const events = await collect(gateway.startTurn(ref, "android-device", "must not be sent"));

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "error");
  assert.deepEqual(events[0]?.payload, {
    code: "SESSION_READ_ONLY",
    message: "This session is read-only until provider resume compatibility is approved.",
  });
  assert.deepEqual(adapter.receivedTurns, []);
});

test("reports provider models and limits together", async () => {
  const adapter = new FakeAdapter();
  const gateway = new GatewayCore([adapter]);

  const event = await gateway.readProviderStatus("status-1");

  assert.equal(event.type, "provider.status");
  assert.equal(event.correlationId, "status-1");
  assert.deepEqual(event.payload.providers, [{
    provider: "codex",
    models: [{ id: "gpt-test", label: "GPT Test", efforts: ["low", "high"], isDefault: true }],
    limits: { usedPercent: 44, windowMinutes: 10080, plan: "plus", status: "allowed" },
  }]);
});

test("keeps provider status usable when a provider cannot answer", async () => {
  const adapter = new FakeAdapter();
  adapter.failModels = true;
  adapter.failLimits = true;
  const gateway = new GatewayCore([adapter]);

  const event = await gateway.readProviderStatus();

  assert.deepEqual(event.payload.providers, [{ provider: "codex", models: [] }]);
  assert.equal(JSON.stringify(event).includes("private model diagnostic"), false);
  assert.equal(JSON.stringify(event).includes("private limits diagnostic"), false);
});

test("creates a new provider session and registers it behind an opaque ref", async () => {
  const adapter = new FakeAdapter();
  const gateway = new GatewayCore([adapter]);

  const events = await collect(gateway.startNewSession("codex", "android-device", "start something", "new-request"));

  assert.deepEqual(adapter.receivedNewSessions, [{ text: "start something", options: undefined }]);
  assert.deepEqual(events.map((event) => event.type), [
    "session.new",
    "session.state",
    "turn.start",
    "item.add",
    "turn.status",
    "session.state",
  ]);
  assert.ok(events.every((event) => event.correlationId === "new-request"));
  const created = (events[0]?.payload as { session: { ref: string; title?: string } }).session;
  assert.ok(created.ref);
  assert.equal(created.title, "Fresh chat");
  assert.equal(JSON.stringify(events).includes(adapter.newSessionId), false);

  // The new session is listed like any other and keeps its reference.
  const listed = await gateway.listSessions();
  assert.equal(listed.payload.sessions.some((session) => session.ref === created.ref), true);
});

test("forwards model and effort overrides to the provider", async () => {
  const adapter = new FakeAdapter();
  const gateway = new GatewayCore([adapter]);
  const listed = await gateway.listSessions();
  const ref = listed.payload.sessions[0]?.ref;
  assert.ok(ref);

  await collect(gateway.startTurn(ref, "android-device", "continue", "turn-1", { model: "opus", effort: "high" }));

  assert.deepEqual(adapter.receivedTurns, [{
    providerSessionId: adapter.providerSessionId,
    text: "continue",
    options: { model: "opus", effort: "high" },
  }]);
});

test("rejects a new session for an unconfigured provider", async () => {
  const gateway = new GatewayCore([new FakeAdapter()]);

  const events = await collect(gateway.startNewSession("claude", "android-device", "hello"));

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "error");
  assert.equal((events[0]?.payload as { code: string }).code, "UNKNOWN_PROVIDER");
});

async function collect(events: AsyncIterable<GatewayEvent>): Promise<GatewayEvent[]> {
  const collected: GatewayEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}
