import assert from "node:assert/strict";
import test from "node:test";
import { resolveClaudeExecutable, resolveCodexExecutable } from "../providers/executables.js";

test("an explicit path wins over every search location", () => {
  assert.equal(resolveClaudeExecutable("  /opt/claude  "), "/opt/claude");
  assert.equal(resolveCodexExecutable("/opt/codex"), "/opt/codex");
});

test("falls back to the environment override", () => {
  const previous = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = "/env/claude";
  try {
    assert.equal(resolveClaudeExecutable(), "/env/claude");
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previous;
  }
});

test("codex resolution always yields a command to spawn", () => {
  const previous = process.env.CODEX_BIN;
  delete process.env.CODEX_BIN;
  try {
    assert.ok(resolveCodexExecutable().length > 0);
  } finally {
    if (previous !== undefined) process.env.CODEX_BIN = previous;
  }
});
