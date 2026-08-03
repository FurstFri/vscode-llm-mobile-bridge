import * as readline from "node:readline";

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line) as { id?: number; method?: string };
  if (request.method === "initialize") {
    process.stdout.write(`${JSON.stringify({ id: request.id, result: { platformOs: "windows" } })}\n`);
  } else if (request.method === "thread/list") {
    process.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [] } })}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ id: request.id, error: { code: -1, message: "unexpected" } })}\n`);
  }
});
