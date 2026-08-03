import { ClaudeProbe } from "./providers/claude.js";
import { CodexProbe } from "./providers/codex.js";

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "probe") {
    console.error("Usage: npm run probe");
    process.exitCode = 2;
    return;
  }

  const results = await Promise.all([new ClaudeProbe().run(), new CodexProbe().run()]);
  process.stdout.write(`${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`);
  if (results.some((result) => result.status === "failed")) process.exitCode = 1;
}

void main();
