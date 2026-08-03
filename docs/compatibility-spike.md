# Compatibility spike — Windows host

Date: 2026-08-03

## Safe checks completed

`npm.cmd run probe` performed no model request, provider turn, or session resume.

- Claude Code 2.1.220 was found in the installed VS Code extension.  Its Agent
  SDK successfully listed five recent local sessions and read one message from
  the most recent session.  The host has 68 local Claude JSONL transcripts.
- Codex App Server from the installed VS Code extension completed the required
  `initialize` / `initialized` handshake, listed five stored threads, and read
  metadata for one thread.

These results validate the read path needed for the Android session list and
history snapshot.  The probe intentionally does not print titles, prompts,
responses, paths, or thread identifiers.

## Codex control-path check

With the account owner's explicit approval, the disposable Codex probe created a
fresh provider-native thread, completed a short no-tools turn, resumed the same
thread id, and completed a second short no-tools turn.  The response content and
thread id were intentionally not logged.

This proves that this installed Codex App Server supports the new-session and
resume control path required by the bridge.

## Remaining acceptance check

Resuming an already existing IDE conversation is intentionally not automated:
it changes a real conversation and can consume subscription/API usage. Run it
only after selecting an explicit test session and a prompt.

The control-path check passes when:

1. The bridge resumes the selected existing Claude/Codex id from the same workspace.
2. The test prompt receives an answer that demonstrates retained context.
3. The provider-native VS Code UI can reopen the same conversation afterwards.

Until then, the implementation must treat existing sessions as read-only.

## Gateway integration status

The gateway now has read-only Claude Agent SDK and Codex App Server adapters for
session listing and snapshot reconstruction.  Their public descriptors contain
an opaque gateway-generated reference and explicit capabilities, never the
provider session id or workspace path.  `canStartTurn` remains disabled and is
checked by the gateway before a writer lease can be acquired.
