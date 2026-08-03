import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";

export interface JsonRpcRequest {
  id?: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export class JsonRpcProcess {
  private readonly pending = new Map<number, { resolve: (response: JsonRpcResponse) => void; reject: (error: Error) => void }>();
  private buffer = "";
  private stderr = "";
  private closed = false;
  private nextId = 1;
  private readonly notifications: JsonRpcNotification[] = [];
  private readonly notificationListeners = new Set<(notification: JsonRpcNotification) => void>();

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.stderr.on("data", (chunk: string) => (this.stderr += chunk));
    child.on("error", (error) => this.failAll(error));
    child.on("close", (code) => {
      this.closed = true;
      this.failAll(new Error(`JSON-RPC process closed (${code}): ${this.stderr.trim()}`));
    });
  }

  static async start(command: string, args: readonly string[]): Promise<JsonRpcProcess> {
    const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    return new JsonRpcProcess(child as ChildProcessWithoutNullStreams);
  }

  async request(method: string, params?: unknown, timeoutMs = 10_000): Promise<JsonRpcResponse> {
    if (this.closed) throw new Error("JSON-RPC process is closed");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for JSON-RPC response to ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (response) => {
          clearTimeout(timeout);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  onNotification(listener: (notification: JsonRpcNotification) => void): () => void {
    for (const buffered of this.notifications) listener(buffered);
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  notify(method: string, params?: unknown): void {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  close(): void {
    if (!this.closed) this.child.kill();
  }

  waitForNotification(
    predicate: (notification: JsonRpcNotification) => boolean,
    timeoutMs = 120_000,
  ): Promise<JsonRpcNotification> {
    const buffered = this.notifications.find(predicate);
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.notificationListeners.delete(listener);
        reject(new Error("Timed out waiting for JSON-RPC notification"));
      }, timeoutMs);
      const listener = (notification: JsonRpcNotification) => {
        if (!predicate(notification)) return;
        clearTimeout(timeout);
        this.notificationListeners.delete(listener);
        resolve(notification);
      };
      this.notificationListeners.add(listener);
    });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (!line) continue;
      try {
        const response = JSON.parse(line) as JsonRpcResponse;
        if (typeof response.id === "number") {
          const pending = this.pending.get(response.id);
          if (pending) {
            this.pending.delete(response.id);
            pending.resolve(response);
          }
        } else {
          const notification = JSON.parse(line) as JsonRpcNotification;
          if (typeof notification.method === "string") {
            this.notifications.push(notification);
            for (const listener of this.notificationListeners) listener(notification);
          }
        }
      } catch {
        // Notifications are intentionally ignored by the probe client.
      }
    }
  }

  private failAll(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    for (const pending of this.pending.values()) pending.reject(normalized);
    this.pending.clear();
  }
}

export async function runJsonRpcSequence(
  command: string,
  args: readonly string[],
  requests: readonly JsonRpcRequest[],
  timeoutMs = 10_000,
): Promise<Map<number, JsonRpcResponse>> {
  const process = await JsonRpcProcess.start(command, args);
  const responses = new Map<number, JsonRpcResponse>();
  try {
    for (const request of requests) {
      if (request.id === undefined) {
        process.notify(request.method, request.params);
        continue;
      }
      responses.set(request.id, await process.request(request.method, request.params, timeoutMs));
    }
    return responses;
  } finally {
    process.close();
  }
}
