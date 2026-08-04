# VS Code LLM Mobile Bridge

This repository contains a runnable local MVP: a VS Code extension with a
Windows session gateway and a Kotlin/Jetpack Compose Android client.  It lists
existing Claude Code and Codex conversations from all local projects, shows
their transcripts, and can send new messages into them — without UI scraping
or screen streaming.

## Extension UI

The extension adds an **LLM Bridge** view to the Activity Bar:

- gateway status (running/stopped, port) with start/stop/copy-pairing/
  disconnect actions;
- the Claude Code and Codex session lists (title, project, last activity);
- clicking a session opens a read-only transcript view.

Key settings (`llmMobileBridge.*`):

- `sessionScope` — `all` (default) shows sessions from every project;
  `workspace` restores the old current-folder filter;
- `sessionLimit` — max sessions per provider (default 100);
- `allowSendingMessages` — allow the phone to send messages into sessions
  (default true);
- `claudePermissionMode` — permission mode for Claude turns started from the
  phone (`default` keeps project permission rules; tools without prior
  approval are denied);
- `relayUrl` — optional wss:// relay for reaching the PC from anywhere (see
  below).

## Relay mode (server as a dumb pipe)

When the phone cannot reach the PC directly, run the relay container on any
server behind a TLS reverse proxy:

```yaml
services:
  relay:
    image: ghcr.io/furstfri/vscode-llm-mobile-bridge:latest
    pull_policy: always
    restart: unless-stopped
    environment:
      RELAY_HOST: 0.0.0.0
      RELAY_PORT: 8765
    ports:
      - "127.0.0.1:8765:8765"
```

Set `llmMobileBridge.relayUrl` to the proxy URL (e.g.
`wss://bridge.example.com`). The extension keeps an outbound connection to
the relay and registers with its pairing token; "Copy Pairing Payload" then
points the phone at the relay. The relay stores nothing, reads no session
data, and needs no token configuration — phones are routed to the host whose
pairing token they present. Sessions, transcripts, and message sending all
run on the PC.

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

## Run the gateway with Docker

The standalone image runs the same authenticated, read-only WebSocket gateway
without installing the VS Code extension. Docker Compose publishes it only on
the host loopback interface and mounts provider data read-only.

1. Copy the environment template and generate a pairing token:

   ```powershell
   Copy-Item .env.example .env
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
   ```

2. Put the generated value in `BRIDGE_TOKEN`, then replace `your-name` in the
   two provider paths inside `.env`.
3. Build and start the gateway:

   ```powershell
   docker compose up --detach --build
   docker compose ps
   ```

4. Copy the pairing JSON and paste it into the Android app:

   ```powershell
   docker compose exec gateway node dist/gateway-daemon.js pairing
   ```

View startup errors with `docker compose logs gateway` and stop the service
with `docker compose down`. For a physical USB device, keep using
`adb reverse tcp:8765 tcp:8765` and set `BRIDGE_MOBILE_URL=ws://127.0.0.1:8765`.

The host `.codex` directory is copied from its read-only mount into ephemeral
container memory at startup because Codex may update auxiliary state. Nothing
is written back to `.codex` or `.claude`. Leave the optional project filters
empty when moving Windows session history into a Linux container; stored
workspace paths otherwise may not match the container path.

Tagged releases publish multi-architecture images to the repository's private
GitHub Container Registry package. After authenticating Docker to `ghcr.io`,
omit `--build` to pull and run the published image. The image installs the
[official Codex CLI package](https://help.openai.com/en/articles/11096431)
and pins its version through `CODEX_VERSION`.

## Build

```powershell
npm.cmd test
npm.cmd run package:vsix
npm.cmd run docker:build
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

Sending messages into existing sessions is now implemented end to end: the
Android composer sends `turn.start`, the gateway claims a single-writer lease,
the Claude adapter resumes the session through the Agent SDK
(`query({ resume })`), and the Codex adapter drives `thread/resume` +
`turn/start` over the app-server protocol, streaming normalized events back to
the phone.  Sending can be disabled with `llmMobileBridge.allowSendingMessages`
(extension) or left disabled via `BRIDGE_ALLOW_TURNS` (Docker daemon, default
off because provider data is mounted read-only there).  The next
implementation slice is persistent opaque-reference storage and the production
outbound WSS/E2EE relay.  The loopback MVP intentionally does not open a LAN
listener.

## Explicit Codex write-path probe

`npm.cmd run codex:control-probe` creates one disposable Codex thread, submits
two fixed no-tools prompts, and verifies that `thread/resume` preserves its id.
It consumes Codex usage and must only be run with the account owner's approval.
