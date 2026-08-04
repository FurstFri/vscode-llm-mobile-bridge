import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RelayServer } from "./relay/relay-server.js";

async function main(): Promise<void> {
  const host = process.env.RELAY_HOST?.trim() || "0.0.0.0";
  const port = parsePort(process.env.RELAY_PORT);
  const server = new RelayServer({ host, port });
  const activePort = await server.start();
  process.stdout.write(`LLM Mobile Bridge relay listening on ws://${host}:${activePort}\n`);

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`Stopping relay (${signal})\n`);
    await server.stop();
  };
  process.once("SIGINT", () => void stop("SIGINT").then(() => process.exit(0)));
  process.once("SIGTERM", () => void stop("SIGTERM").then(() => process.exit(0)));
}

function parsePort(value: string | undefined): number {
  if (!value) return 8765;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("RELAY_PORT must be an integer between 1 and 65535");
  }
  return port;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`LLM Mobile Bridge relay failed: ${message}\n`);
    process.exitCode = 1;
  });
}
