import { randomUUID } from "node:crypto";
import type { Provider } from "../model.js";
import type { GatewayEvent, GatewayEventType, SessionDescriptor, SessionSnapshot } from "./protocol.js";
import type { NewSessionAnnouncement, ProviderAdapter, TurnOptions } from "./provider-adapter.js";
import { SessionRegistry } from "./session-registry.js";
import type { WriterLease } from "./protocol.js";

export class GatewayCore {
  private readonly adapters = new Map<Provider, ProviderAdapter>();
  private gatewaySequence = 0;

  constructor(
    adapters: readonly ProviderAdapter[],
    private readonly registry = new SessionRegistry(),
    private readonly log?: (message: string) => void,
  ) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.provider)) throw new Error(`Duplicate provider adapter: ${adapter.provider}`);
      this.adapters.set(adapter.provider, adapter);
    }
  }

  async listSessions(correlationId: string = randomUUID()): Promise<GatewayEvent<{ sessions: SessionDescriptor[] }>> {
    for (const adapter of this.adapters.values()) {
      try {
        const sessions = await adapter.listSessions();
        for (const session of sessions) {
          this.registry.registerOrGet({
            provider: adapter.provider,
            providerSessionId: session.providerSessionId,
            title: session.title,
            capabilities: session.capabilities,
            project: session.project,
            updatedAt: session.updatedAt,
          });
        }
      } catch {
        // A session.list snapshot carries the offline state itself, so no
        // per-session sequence numbers are consumed for events we do not emit.
        this.registry.setHostOffline(adapter.provider);
      }
    }

    this.gatewaySequence += 1;
    return {
      protocolVersion: 1,
      messageId: randomUUID(),
      correlationId,
      sessionRef: "gateway",
      sequence: this.gatewaySequence,
      type: "session.list",
      payload: { sessions: this.registry.list() },
    };
  }

  async readSnapshot(ref: string, correlationId: string = randomUUID()): Promise<GatewayEvent<SessionSnapshot>> {
    const binding = this.registry.getBinding(ref);
    const adapter = this.requireAdapter(binding.provider);
    const providerSnapshot = await adapter.readSnapshot(binding.providerSessionId);
    const session = this.registry.reconcileSnapshot(ref, providerSnapshot.revision, providerSnapshot.state);
    return this.registry.createEvent(ref, "session.snapshot", {
      session,
      items: providerSnapshot.items,
    }, correlationId);
  }

  async *startTurn(
    ref: string,
    owner: string,
    text: string,
    correlationId: string = randomUUID(),
    options?: TurnOptions,
  ): AsyncGenerator<GatewayEvent> {
    if (!text.trim()) {
      yield this.registry.createEvent(ref, "error", {
        code: "EMPTY_PROMPT",
        message: "The prompt must not be empty.",
      }, correlationId);
      return;
    }

    const session = this.registry.get(ref);
    if (!session?.capabilities.canStartTurn) {
      yield this.registry.createEvent(ref, "error", {
        code: "SESSION_READ_ONLY",
        message: "This session is read-only until provider resume compatibility is approved.",
      }, correlationId);
      return;
    }

    const claim = this.registry.claimWriter(ref, owner, correlationId);
    yield claim.event;
    if (!claim.ok) return;

    const binding = this.registry.getBinding(ref);
    const adapter = this.requireAdapter(binding.provider);
    this.log?.(`Turn started (${binding.provider}, owner ${owner}).`);
    yield this.registry.createEvent(ref, "turn.start", { owner }, correlationId);

    try {
      for await (const providerEvent of adapter.startTurn(binding.providerSessionId, text, options)) {
        yield this.registry.createEvent(ref, providerEvent.type, providerEvent.payload, correlationId);
      }
      this.log?.(`Turn completed (${binding.provider}).`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log?.(`Turn failed (${binding.provider}): ${detail}`);
      yield this.registry.createEvent(ref, "error", {
        code: "PROVIDER_TURN_FAILED",
        message: "The provider could not complete the turn.",
        detail,
      }, correlationId);
    } finally {
      claim.lease.release();
    }

    const state = this.registry.get(ref)?.state ?? "host_offline";
    yield this.registry.createEvent(ref, "session.state", { state }, correlationId);
  }

  /** Creates a fresh provider session and streams its first turn. */
  async *startNewSession(
    provider: Provider,
    owner: string,
    text: string,
    correlationId: string = randomUUID(),
    options?: TurnOptions,
  ): AsyncGenerator<GatewayEvent> {
    if (!text.trim()) {
      yield this.gatewayEvent("error", {
        code: "EMPTY_PROMPT",
        message: "The prompt must not be empty.",
      }, correlationId);
      return;
    }
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      yield this.gatewayEvent("error", {
        code: "UNKNOWN_PROVIDER",
        message: `Provider is not configured: ${provider}.`,
      }, correlationId);
      return;
    }

    this.log?.(`New session requested (${provider}, owner ${owner}).`);
    let ref: string | undefined;
    let lease: WriterLease | undefined;
    try {
      for await (const providerEvent of adapter.startNewSession(text, options)) {
        if (providerEvent.type === "session.new") {
          const announcement = providerEvent.payload as NewSessionAnnouncement;
          const descriptor = this.registry.registerOrGet({
            provider,
            providerSessionId: announcement.providerSessionId,
            title: announcement.title,
            project: announcement.project,
            updatedAt: announcement.updatedAt,
          });
          ref = descriptor.ref;
          yield this.registry.createEvent(ref, "session.new", { session: this.registry.get(ref) }, correlationId);
          const claim = this.registry.claimWriter(ref, owner, correlationId);
          yield claim.event;
          if (claim.ok) lease = claim.lease;
          yield this.registry.createEvent(ref, "turn.start", { owner }, correlationId);
        } else if (ref) {
          yield this.registry.createEvent(ref, providerEvent.type, providerEvent.payload, correlationId);
        }
      }
      this.log?.(`New session turn completed (${provider}).`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log?.(`New session turn failed (${provider}): ${detail}`);
      const payload = {
        code: "PROVIDER_TURN_FAILED",
        message: "The provider could not complete the turn.",
        detail,
      };
      yield ref
        ? this.registry.createEvent(ref, "error", payload, correlationId)
        : this.gatewayEvent("error", payload, correlationId);
    } finally {
      lease?.release();
    }
    if (ref) {
      const state = this.registry.get(ref)?.state ?? "host_offline";
      yield this.registry.createEvent(ref, "session.state", { state }, correlationId);
    }
  }

  private gatewayEvent(type: GatewayEventType, payload: unknown, correlationId: string): GatewayEvent {
    this.gatewaySequence += 1;
    return {
      protocolVersion: 1,
      messageId: randomUUID(),
      correlationId,
      sessionRef: "gateway",
      sequence: this.gatewaySequence,
      type,
      payload,
    };
  }

  private requireAdapter(provider: Provider): ProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new Error(`Provider adapter is not configured: ${provider}`);
    return adapter;
  }
}
