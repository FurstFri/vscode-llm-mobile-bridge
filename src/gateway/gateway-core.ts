import { randomUUID } from "node:crypto";
import type { Provider } from "../model.js";
import type { GatewayEvent, SessionDescriptor, SessionSnapshot } from "./protocol.js";
import type { ProviderAdapter } from "./provider-adapter.js";
import { SessionRegistry } from "./session-registry.js";

export class GatewayCore {
  private readonly adapters = new Map<Provider, ProviderAdapter>();
  private gatewaySequence = 0;

  constructor(
    adapters: readonly ProviderAdapter[],
    private readonly registry = new SessionRegistry(),
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
    yield this.registry.createEvent(ref, "turn.start", { owner }, correlationId);

    try {
      for await (const providerEvent of adapter.startTurn(binding.providerSessionId, text)) {
        yield this.registry.createEvent(ref, providerEvent.type, providerEvent.payload, correlationId);
      }
    } catch {
      yield this.registry.createEvent(ref, "error", {
        code: "PROVIDER_TURN_FAILED",
        message: "The provider could not complete the turn.",
      }, correlationId);
    } finally {
      claim.lease.release();
    }

    const state = this.registry.get(ref)?.state ?? "host_offline";
    yield this.registry.createEvent(ref, "session.state", { state }, correlationId);
  }

  private requireAdapter(provider: Provider): ProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new Error(`Provider adapter is not configured: ${provider}`);
    return adapter;
  }
}
