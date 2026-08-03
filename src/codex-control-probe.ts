import { JsonRpcNotification, JsonRpcProcess } from "./providers/json-rpc-client.js";

const codexExecutable = process.env.CODEX_BIN ?? "codex";
const firstPrompt = "Reply with exactly BRIDGE_PROBE_ONE. Do not read or modify files, run commands, or call tools.";
const secondPrompt = "Reply with exactly BRIDGE_PROBE_TWO. Do not read or modify files, run commands, or call tools.";

async function main(): Promise<void> {
  const appServer = await JsonRpcProcess.start(codexExecutable, ["app-server", "--stdio"]);
  try {
    const initialized = await appServer.request("initialize", {
      clientInfo: { name: "vscode-llm-mobile-bridge", title: "VS Code LLM Mobile Bridge", version: "0.1.0" },
    });
    assertSuccess(initialized, "initialize");
    appServer.notify("initialized", {});

    const started = await appServer.request("thread/start", { cwd: process.cwd() });
    assertSuccess(started, "thread/start");
    const threadId = findId(started.result, "thread");
    if (!threadId) throw new Error("thread/start did not return a thread id");

    const firstTurn = await startTurn(appServer, threadId, firstPrompt);
    await waitForTurn(appServer, firstTurn);

    const resumed = await appServer.request("thread/resume", { threadId });
    assertSuccess(resumed, "thread/resume");
    const resumedThreadId = findId(resumed.result, "thread");
    if (resumedThreadId !== threadId) throw new Error("thread/resume did not preserve the created thread id");

    const secondTurn = await startTurn(appServer, threadId, secondPrompt);
    await waitForTurn(appServer, secondTurn);

    process.stdout.write(`${JSON.stringify({
      status: "ready",
      provider: "codex",
      threadCreated: true,
      threadResumed: true,
      turnsCompleted: 2,
      note: "A disposable provider-native test thread was created; response content is intentionally not logged.",
    }, null, 2)}\n`);
  } finally {
    appServer.close();
  }
}

async function startTurn(appServer: JsonRpcProcess, threadId: string, text: string): Promise<string> {
  const response = await appServer.request("turn/start", {
    threadId,
    input: [{ type: "text", text }],
  });
  assertSuccess(response, "turn/start");
  const turnId = findId(response.result, "turn");
  if (!turnId) throw new Error("turn/start did not return a turn id");
  return turnId;
}

async function waitForTurn(appServer: JsonRpcProcess, turnId: string): Promise<void> {
  const notification = await appServer.waitForNotification((candidate) => {
    if (candidate.method !== "turn/completed") return false;
    return findId(candidate.params, "turn") === turnId;
  });
  const status = findString(notification.params, ["turn", "status"]);
  if (status && status !== "completed") throw new Error(`Turn ${turnId} finished with status ${status}`);
}

function assertSuccess(response: { error?: { message?: string } }, method: string): void {
  if (response.error) throw new Error(`${method}: ${response.error.message ?? "unknown JSON-RPC error"}`);
}

function findId(value: unknown, field: string): string | undefined {
  const record = asObject(value);
  const nested = asObject(record?.[field]);
  return typeof nested?.id === "string" ? nested.id : undefined;
}

function findString(value: unknown, path: string[]): string | undefined {
  let current: unknown = value;
  for (const segment of path) current = asObject(current)?.[segment];
  return typeof current === "string" ? current : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

void main();
