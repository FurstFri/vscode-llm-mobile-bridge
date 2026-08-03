# VS Code LLM Mobile Bridge — design

## Goal

Give an Android phone a functional, visually similar mobile view of Claude Code
and Codex conversations that run in a Windows VS Code workspace.  The phone can
open an existing conversation, observe its state, send the next prompt, approve
an allowed action, or start a new conversation.

This is a session bridge, not remote desktop software: it does not capture VS
Code pixels, access another extension's DOM, or store a second cloud copy of
conversation content.

## Constraints and non-goals

- Host OS for the first release is Windows and the host must have VS Code open.
- Phone target is Android.
- The mobile UI is a responsive functional clone, not a pixel-perfect copy of
  the IDE panels.
- The service is reachable through a public domain.  Both endpoint clients make
  outbound connections; no port is opened on the Windows computer.
- The terminal is intentionally out of scope; the user uses SSH separately.
- The relay never persists prompt, response, tool output, file names, or code.
- The initial release is one account owner and their trusted devices, not a team
  product.

## Provider capability boundary

The bridge does not inspect third-party VS Code webviews.  It uses documented
provider session mechanisms and converts provider events into a common model.

### Claude Code adapter

The adapter uses the Claude Agent SDK locally on Windows to list local sessions,
read the selected transcript, and resume a specific session id.  A new mobile
conversation is started locally by the SDK and returns its provider session id.
The extension can later open the corresponding native Claude tab with the
documented URI handler.

When a Claude tab already has a turn in progress, the gateway only observes its
persisted transcript and reports `busy`; it does not create a second writer.
Once that turn is terminal, the gateway can resume the same id and becomes the
sole writer for turns submitted from Android.  A user who enters text directly
in VS Code while the gateway owns the session is warned that it can cause a
provider-level conflict; the gateway detects a changed transcript and reloads
before allowing its next write.

### Codex adapter

The adapter launches a local `codex app-server` subprocess over stdio and uses
the generated schema for that installed Codex version.  It calls `thread/list`,
`thread/read`, `thread/resume`, and `thread/start` and maps streamed item and
approval notifications to the common model.

Whether a second local app-server process can safely observe an IDE extension's
currently active thread is a release gate, not an assumption.  The first
implementation milestone proves this against the user's installed Codex version.
Until proven, completed persisted threads are supported and an active IDE thread
is shown as `busy`, without a second writer.

## Components

```text
Claude Code / Codex local state and processes
                    |
                    v
VS Code extension + Windows Session Gateway
  - provider adapters, session ownership, event normalization
  - encrypted outbound WebSocket and device pairing controls
                    |
                    | TLS carrying end-to-end encrypted frames
                    v
relay.example.com
  - account/device authorization, presence, opaque-frame routing, audit metadata
                    |
                    v
Android application
  - session list and chat UI, passkey/biometric unlock, encrypted transport
```

### VS Code extension and Session Gateway

One TypeScript extension contains a small gateway service in its extension host.
It starts only in a trusted workspace, holds one authenticated outbound WebSocket
to the relay, and exposes commands for linking a phone, displaying connection
state, revoking a phone, and opening a provider session locally.

`SessionRegistry` owns session state and a per-provider-session mutex.  It is
the only component allowed to call a provider adapter's write operation.
`EventNormalizer` emits versioned common events; it never emits an API key,
provider OAuth token, or unredacted local path unless that text already belongs
to the displayed provider conversation.

The device encryption and signing material is stored through VS Code
`SecretStorage`, which on Windows uses the OS credential-protection facility.
The extension shows a persistent status-bar indicator whenever a phone is
connected and offers an immediate `Disconnect all phones` command.

### Relay service

The relay is a Go service behind HTTPS at the user's domain and backed by
PostgreSQL.  It stores accounts, public device keys, passkey credentials,
encrypted TOTP secrets, pair bindings, refresh-token records, revocations, and
content-free audit events.  Presence can live in memory for the first single
instance deployment; Redis is added before horizontal scaling.

The relay authenticates the WebSocket endpoints and routes opaque encrypted
frames only between linked devices in the same account.  It has no decryption
keys and does not write frames to logs, databases, queues, or error reports.

### Android application

The Android application uses Kotlin and Jetpack Compose.  It presents the
provider-neutral session list, a chat timeline, tool progress, action approvals,
and a `New conversation` action.  It uses Android Credential Manager for
passkeys, Android Keystore for device keys, biometric authentication before
opening a linked account, `FLAG_SECURE` for sensitive screens, and a foreground
service while a live session is open.

The app contains no Claude, Codex, or workspace credential.  It sends a user
intent to the Windows gateway, which alone invokes the provider.

## Common session protocol

Protocol messages use a versioned CBOR envelope inside encrypted frames.  The
initial event set is:

- `session.list`, `session.snapshot`, `session.state`
- `turn.start`, `turn.cancel`, `turn.status`
- `item.add`, `item.delta`, `item.complete`
- `tool.request`, `tool.progress`, `tool.complete`
- `approval.request`, `approval.respond`
- `session.new`, `session.resume`, `session.conflict`
- `error` with a public, actionable code only

Each event includes `protocolVersion`, `messageId`, `sessionRef`, a monotonic
per-session sequence number, and a correlation id.  Android de-duplicates
`messageId`s and requests `session.snapshot` after reconnecting or finding a
sequence gap.  The snapshot comes directly from Windows; it is not cached by the
relay.

Provider ids never become public route ids.  `sessionRef` is a random opaque id
bound by the gateway to a provider and local provider session id.

## Authentication, two-factor authentication, and linking

### Account authentication

The account has no reusable password.  A passkey is the primary factor.  TOTP is
required as a recovery/step-up factor for sensitive actions: enrolling a first
device after recovery, linking a device, revoking all devices, and changing the
TOTP configuration.  The user receives single-use recovery codes when enabling
TOTP and must store them offline.

Access tokens are short-lived, audience-bound and sender-constrained to a
device signing key.  Refresh-token rotation detects reuse and immediately
revokes the token family.  Rate limits apply to login, WebAuthn challenges,
TOTP checks, pairing, and WebSocket reconnects.

### Device keys and pair binding

Each endpoint creates:

- an Ed25519 signing key;
- an X25519 encryption key;
- an OS-protected storage binding.

The relay stores only public keys.  A device can connect only after a pair
binding connects its public key to an existing trusted device.

1. The already-authenticated Windows extension creates a two-minute pairing
   offer with a 128-bit nonce and an ephemeral X25519 public key.
2. It displays a QR code containing the relay origin, offer id, nonce, and
   ephemeral public key.  No long-lived secret is in the QR code.
3. The Android user signs in with a passkey and verifies TOTP, scans the code,
   and sends its public device keys plus a signed pairing request to the relay.
4. Relay notifies Windows through its existing authenticated channel.  Both apps
   derive a short authentication string from the pairing transcript and require
   explicit local confirmation.
5. Both devices sign the resulting pair binding.  The relay activates it only
   after both signatures verify and records a content-free audit event.

There is no silent pairing, pairing by IP address, or pairing by a reusable
numeric code.  Revoking a device immediately invalidates its token family,
disconnects it, and prohibits new encrypted-channel handshakes.

### End-to-end frame encryption

TLS protects transport to the domain.  Above it, linked device pairs establish
an authenticated ephemeral X25519 session using a vetted Noise-style library;
Ed25519 signatures bind the handshake to registered device keys.  HKDF derives
directional keys and ChaCha20-Poly1305 encrypts every application envelope.
Nonces are monotonically allocated per key and rekeys happen on reconnect and
after a bounded frame/time limit.  The relay sees routing metadata only.

Cryptographic primitives are used from maintained platform libraries; the
project does not implement cryptographic algorithms itself.

## State and lifecycle

- Opening Android lists currently available sessions from the Windows gateway.
- Selecting a completed session fetches its snapshot, then calls provider
  `resume` only when the user sends a new prompt.
- Selecting a session with an active provider turn is view-only until terminal.
- `New conversation` creates a provider-native session for the current active
  workspace, records the opaque mapping locally, and opens the matching native
  IDE session when requested.
- VS Code closing, host sleep, provider login loss, or a WebSocket failure moves
  Android to `host_offline`; input is disabled.  On reconnect it fetches a fresh
  snapshot before enabling input.
- The gateway never queues a user prompt while offline.  Android keeps it as an
  unsent local draft, so the user must explicitly send after reconnection.

## Security policy for actions

The phone may approve only provider approval prompts represented by the adapter.
It cannot execute arbitrary shell commands, browse workspace files outside the
provider's own request, change VS Code configuration, or alter provider account
credentials.  High-impact provider actions always display the exact provider
summary and require Android biometrics immediately before approval.  The gateway
adds a local five-minute approval lease and rejects delayed/replayed approvals.

## Failure handling

- Invalid authentication, expired pairing, signature failure, sequence gap, or
  decryption failure is fail-closed and emits no sensitive diagnostic.
- A duplicated or stale event is ignored; a gap triggers snapshot recovery.
- Provider unsupported/version mismatch is displayed as a capability error and
  leaves the original IDE session unchanged.
- A conflicting local write blocks remote write, reloads the provider state, and
  asks the user to retry rather than merging guesses.
- Relay restart preserves no conversation state; clients reconnect and receive a
  fresh host snapshot.

## Implementation sequence and acceptance tests

1. **Compatibility spike.** On Windows, prove Claude session list/read/resume
   from the Agent SDK against an existing VS Code conversation.  Prove Codex
   app-server list/read/resume against a running IDE extension and document the
   result.  No remote network or Android code in this step.
2. **Gateway core.** Implement the normalized protocol, session locks, snapshot
   recovery, Claude adapter, and provider-independent automated tests with fake
   adapters.
3. **Relay and identity.** Implement passkey/TOTP enrollment, pair binding,
   device revocation, TLS/WSS presence, opaque-frame routing, and an audited
   PostgreSQL schema.
4. **Android client.** Implement enrollment/linking, biometric lock, session
   list/timeline/draft/approval UI, encrypted transport, and reconnect behavior.
5. **Codex adapter.** Enable it only after the spike's acceptance criteria pass.
6. **Hardening.** Run protocol fuzzing, reconnect/race tests, lost-device and
   replay tests, package-signing verification, and an end-to-end test on a
   Windows host and physical Android device over a non-LAN network.

The compatibility spike passes only if a real existing session can be listed,
its reconstructed snapshot matches the provider's history, a resumed prompt
keeps prior context, and the native IDE can subsequently reopen the same
conversation.  If a provider cannot meet that condition with public mechanisms,
the product exposes it as read-only/unsupported rather than using UI scraping.
