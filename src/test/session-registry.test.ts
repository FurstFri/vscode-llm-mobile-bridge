import assert from "node:assert/strict";
import test from "node:test";
import { SessionRegistry } from "../gateway/session-registry.js";

test("allows exactly one writer and returns to idle on release", () => {
  const registry = new SessionRegistry();
  registry.register({ ref: "mobile-session", provider: "codex", providerSessionId: "thr_test" });

  const first = registry.claimWriter("mobile-session", "android-device");
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.event.sequence, 1);
  assert.equal(registry.get("mobile-session")?.state, "busy");

  const second = registry.claimWriter("mobile-session", "vscode-local");
  assert.equal(second.ok, false);
  assert.equal(second.event.type, "session.conflict");

  first.lease.release();
  assert.equal(registry.get("mobile-session")?.state, "idle");
});

test("marks an externally changed session as conflicting while a writer is active", () => {
  const registry = new SessionRegistry();
  registry.register({ ref: "mobile-session", provider: "claude", providerSessionId: "session_test" });
  const lease = registry.claimWriter("mobile-session", "android-device");
  assert.equal(lease.ok, true);

  const event = registry.updateObservedRevision("mobile-session", 12);
  assert.equal(event.type, "session.conflict");
  assert.equal(registry.get("mobile-session")?.state, "conflict");
});

test("does not report a conflict when an observed revision has not changed", () => {
  const registry = new SessionRegistry();
  registry.register({ ref: "mobile-session", provider: "codex", providerSessionId: "thr_test" });
  const lease = registry.claimWriter("mobile-session", "android-device");
  assert.equal(lease.ok, true);

  const event = registry.updateObservedRevision("mobile-session", 0);
  assert.equal(event.type, "session.state");
  assert.equal(registry.get("mobile-session")?.state, "busy");
});

test("keeps a conflict after release until a fresh snapshot reconciles it", () => {
  const registry = new SessionRegistry();
  registry.register({ ref: "mobile-session", provider: "claude", providerSessionId: "session_test" });
  const claim = registry.claimWriter("mobile-session", "android-device");
  assert.equal(claim.ok, true);
  if (!claim.ok) return;

  registry.updateObservedRevision("mobile-session", "changed-outside-gateway");
  claim.lease.release();
  assert.equal(registry.get("mobile-session")?.state, "conflict");

  registry.reconcileSnapshot("mobile-session", "fresh-snapshot", "idle");
  assert.equal(registry.get("mobile-session")?.state, "idle");
});

test("uses one public reference for the same provider session", () => {
  const registry = new SessionRegistry();
  const first = registry.registerOrGet({ provider: "codex", providerSessionId: "private-thread" });
  const second = registry.registerOrGet({ provider: "codex", providerSessionId: "private-thread" });

  assert.equal(second.ref, first.ref);
  assert.equal(Object.hasOwn(first, "providerSessionId"), false);
});
