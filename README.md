# VS Code LLM Mobile Bridge

This repository contains a runnable local MVP: a VS Code extension with a
Windows session gateway and a Kotlin/Jetpack Compose Android client.  It reads
existing Claude Code and Codex conversations without UI scraping or screen
streaming.

## Install the local MVP

Build artifacts are created in `artifacts/`:

- `llm-mobile-bridge.vsix` — the VS Code extension and loopback gateway;
- `llm-mobile-bridge-debug.apk` — the Android debug client.

Install the extension:

```powershell
code --install-extension artifacts/llm-mobile-bridge.vsix --force
```

Open a trusted workspace and run `LLM Mobile Bridge: Copy Pairing Payload` from
the Command Palette.  In the Android app, paste that JSON into the pairing
screen.  The default `ws://10.0.2.2:8765` URL is for an Android emulator.

For a USB-connected physical device, keep the gateway loopback-only:

```powershell
adb reverse tcp:8765 tcp:8765
```

Then set `llmMobileBridge.mobileUrl` to `ws://127.0.0.1:8765` before copying the
pairing payload.  The debug app permits cleartext WebSocket only for this local
development path; production transport requires the planned WSS/E2EE relay.

## Build

```powershell
npm.cmd test
npm.cmd run package:vsix
cd android
.\gradlew.bat testDebugUnitTest assembleDebug
```

## Run the safe local probe

```powershell
npm.cmd install
npm.cmd run probe
```

The probe lists and reads local provider session metadata. It sends Codex
`initialize`, `initialized`, `thread/list`, and `thread/read`; it also asks the
Claude Agent SDK to list sessions and read one message. It never starts a turn,
resumes a conversation, or sends an LLM prompt. Set `CODEX_BIN` or `CLAUDE_BIN`
if either CLI is outside `PATH`.

See the approved design in
`docs/superpowers/specs/2026-08-03-vscode-llm-mobile-bridge-design.md`.

## Gateway core status

The provider-neutral gateway foundation now includes:

- opaque, stable in-process `sessionRef` values that do not expose provider ids;
- normalized versioned events with correlation ids and per-session sequences;
- snapshot reconciliation for reconnect and conflict recovery;
- single-writer leases that preserve externally detected conflicts;
- a provider adapter contract and automated fake-adapter tests;
- a read-only Claude adapter that normalizes transcript messages, reasoning,
  and tool results without exposing workspace paths.
- a read-only Codex App Server adapter that maps stored turns and tool activity
  through the same provider-neutral timeline;
- an authenticated loopback WebSocket transport and versioned mobile request
  protocol;
- trusted-workspace lifecycle, `SecretStorage` pairing token rotation, status
  bar state, and disconnect-all commands in the VS Code extension;
- a Compose Android client with Keystore-encrypted pairing storage,
  `FLAG_SECURE`, session list, and transcript timeline.

Existing provider conversations advertise `canStartTurn: false`, and the gateway
enforces that capability before acquiring a writer lease.  Write/resume remains
disabled until the explicit existing-session acceptance check passes.  The next
implementation slice is persistent opaque-reference storage and the production
outbound WSS/E2EE relay.  The loopback MVP intentionally does not open a LAN
listener.

## Explicit Codex write-path probe

`npm.cmd run codex:control-probe` creates one disposable Codex thread, submits
two fixed no-tools prompts, and verifies that `thread/resume` preserves its id.
It consumes Codex usage and must only be run with the account owner's approval.
