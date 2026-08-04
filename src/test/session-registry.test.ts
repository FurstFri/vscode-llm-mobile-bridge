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

test("keeps the session busy when its own turn changes the revision", () => {
  const registry = new SessionRegistry();
  registry.register({ ref: "mobile-session", provider: "claude", providerSessionId: "session_test" });
  const lease = registry.claimWriter("mobile-session", "android-device");
  assert.equal(lease.ok, true);

  // A streamed turn writes into provider storage, so snapshot polls observe
  // new revisions while the writer is active — that must not self-conflict.
  const event = registry.updateObservedRevision("mobile-session", 12);
  assert.equal(event.type, "session.state");
  assert.equal(registry.get("mobile-session")?.state, "busy");
  assert.equal(registry.get("mobile-session")?.revision, 12);
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

test("returns to idle after release and reconciles fresh snapshots", () => {
  const registry = new SessionRegistry();
  registry.register({ ref: "mobile-session", provider: "claude", providerSessionId: "session_test" });
  const claim = registry.claimWriter("mobile-session", "android-device");
  assert.equal(claim.ok, true);
  if (!claim.ok) return;

  registry.updateObservedRevision("mobile-session", "changed-during-turn");
  claim.lease.release();
  assert.equal(registry.get("mobile-session")?.state, "idle");

  registry.reconcileSnapshot("mobile-session", "fresh-snapshot", "idle");
  assert.equal(registry.get("mobile-session")?.state, "idle");
});

test("keeps references stable across gateway restarts", () => {
  // A restart builds a fresh registry; the phone still holds the old ref.
  const first = new SessionRegistry("machine-salt");
  const second = new SessionRegistry("machine-salt");

  const before = first.registerOrGet({ provider: "claude", providerSessionId: "private-session" });
  const after = second.registerOrGet({ provider: "claude", providerSessionId: "private-session" });

  assert.equal(after.ref, before.ref);
  assert.equal(before.ref.includes("private-session"), false);
});

test("gives different machines different references for the same id", () => {
  const one = new SessionRegistry("salt-one");
  const two = new SessionRegistry("salt-two");

  const a = one.registerOrGet({ provider: "codex", providerSessionId: "thr_1" });
  const b = two.registerOrGet({ provider: "codex", providerSessionId: "thr_1" });

  assert.notEqual(a.ref, b.ref);
});

test("uses one public reference for the same provider session", () => {
  const registry = new SessionRegistry();
  const first = registry.registerOrGet({ provider: "codex", providerSessionId: "private-thread" });
  const second = registry.registerOrGet({ provider: "codex", providerSessionId: "private-thread" });

  assert.equal(second.ref, first.ref);
  assert.equal(Object.hasOwn(first, "providerSessionId"), false);
});
