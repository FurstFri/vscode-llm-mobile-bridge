import { randomUUID } from "node:crypto";
import type { Provider } from "../model.js";
import {
  GatewayEvent,
  GatewayEventType,
  SessionCapabilities,
  SessionDescriptor,
  SessionRevision,
  SessionState,
  WriterLease,
} from "./protocol.js";

interface ManagedSession extends SessionDescriptor {
  providerSessionId: string;
  sequence: number;
  writer?: string;
}

export interface SessionRegistration {
  ref?: string;
  provider: Provider;
  providerSessionId: string;
  title?: string;
  capabilities?: SessionCapabilities;
}

export interface SessionBinding {
  provider: Provider;
  providerSessionId: string;
}

export type WriterClaim =
  | { ok: true; lease: WriterLease; event: GatewayEvent<{ state: "busy"; owner: string }> }
  | {
      ok: false;
      event: GatewayEvent<{
        state: "busy" | "conflict" | "host_offline";
        reason: "writer_active" | "unresolved_conflict" | "host_offline";
        owner?: string;
      }>;
    };

export class SessionRegistry {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly refsByProviderSession = new Map<string, string>();

  register(registration: SessionRegistration & { ref: string }): SessionDescriptor {
    if (this.sessions.has(registration.ref)) throw new Error(`Session already registered: ${registration.ref}`);
    const identity = this.identity(registration.provider, registration.providerSessionId);
    if (this.refsByProviderSession.has(identity)) {
      throw new Error(`Provider session already registered: ${registration.provider}`);
    }
    const session: ManagedSession = {
      ref: registration.ref,
      provider: registration.provider,
      providerSessionId: registration.providerSessionId,
      title: registration.title,
      capabilities: registration.capabilities ?? {
        canRead: true,
        canStartTurn: true,
        canApprove: false,
      },
      state: "idle",
      revision: 0,
      sequence: 0,
    };
    this.sessions.set(session.ref, session);
    this.refsByProviderSession.set(identity, session.ref);
    return this.snapshot(session);
  }

  registerOrGet(registration: Omit<SessionRegistration, "ref">): SessionDescriptor {
    const identity = this.identity(registration.provider, registration.providerSessionId);
    const existingRef = this.refsByProviderSession.get(identity);
    if (existingRef) {
      const existing = this.require(existingRef);
      existing.title = registration.title ?? existing.title;
      existing.capabilities = registration.capabilities ?? existing.capabilities;
      return this.snapshot(existing);
    }
    return this.register({ ...registration, ref: randomUUID() });
  }

  list(): SessionDescriptor[] {
    return [...this.sessions.values()].map((session) => this.snapshot(session));
  }

  get(ref: string): SessionDescriptor | undefined {
    const session = this.sessions.get(ref);
    return session ? this.snapshot(session) : undefined;
  }

  getBinding(ref: string): SessionBinding {
    const session = this.require(ref);
    return { provider: session.provider, providerSessionId: session.providerSessionId };
  }

  reconcileSnapshot(ref: string, revision: SessionRevision, observedState: "idle" | "busy"): SessionDescriptor {
    const session = this.require(ref);
    const changed = session.revision !== revision;
    session.revision = revision;
    if (session.writer && changed) {
      session.state = "conflict";
    } else if (!session.writer) {
      session.state = observedState;
    }
    return this.snapshot(session);
  }

  updateObservedRevision(ref: string, revision: SessionRevision): GatewayEvent<{ state: SessionState; revision: SessionRevision }> {
    const session = this.require(ref);
    const snapshot = this.reconcileSnapshot(ref, revision, session.writer ? "busy" : "idle");
    return this.createEvent(
      ref,
      snapshot.state === "conflict" ? "session.conflict" : "session.state",
      { state: snapshot.state, revision: snapshot.revision },
    );
  }

  markHostOffline(provider?: Provider): GatewayEvent<{ state: "host_offline" }>[] {
    const events: GatewayEvent<{ state: "host_offline" }>[] = [];
    for (const session of this.sessions.values()) {
      if (provider && session.provider !== provider) continue;
      session.state = "host_offline";
      events.push(this.createEvent(session.ref, "session.state", { state: "host_offline" }));
    }
    return events;
  }

  setHostOffline(provider?: Provider): void {
    for (const session of this.sessions.values()) {
      if (!provider || session.provider === provider) session.state = "host_offline";
    }
  }

  claimWriter(ref: string, owner: string, correlationId: string = randomUUID()): WriterClaim {
    const session = this.require(ref);
    if (session.state === "host_offline") {
      return {
        ok: false,
        event: this.createEvent(ref, "error", {
          state: "host_offline",
          reason: "host_offline",
        }, correlationId),
      };
    }
    if (session.writer) {
      return {
        ok: false,
        event: this.createEvent(ref, "session.conflict", {
          state: "busy",
          reason: "writer_active",
          owner: session.writer,
        }, correlationId),
      };
    }
    if (session.state === "conflict") {
      return {
        ok: false,
        event: this.createEvent(ref, "session.conflict", {
          state: "conflict",
          reason: "unresolved_conflict",
        }, correlationId),
      };
    }
    session.writer = owner;
    session.state = "busy";
    let released = false;
    return {
      ok: true,
      event: this.createEvent(ref, "session.state", { state: "busy", owner }, correlationId),
      lease: {
        sessionRef: ref,
        owner,
        release: () => {
          if (released) return;
          released = true;
          const latest = this.sessions.get(ref);
          if (latest?.writer === owner) {
            latest.writer = undefined;
            if (latest.state !== "conflict" && latest.state !== "host_offline") latest.state = "idle";
          }
        },
      },
    };
  }

  createEvent<TPayload>(
    ref: string,
    type: GatewayEventType,
    payload: TPayload,
    correlationId: string = randomUUID(),
  ): GatewayEvent<TPayload> {
    const session = this.require(ref);
    session.sequence += 1;
    return {
      protocolVersion: 1,
      messageId: randomUUID(),
      correlationId,
      sessionRef: session.ref,
      sequence: session.sequence,
      type,
      payload,
    };
  }

  private identity(provider: Provider, providerSessionId: string): string {
    return `${provider}\0${providerSessionId}`;
  }

  private require(ref: string): ManagedSession {
    const session = this.sessions.get(ref);
    if (!session) throw new Error(`Unknown session: ${ref}`);
    return session;
  }

  private snapshot(session: ManagedSession): SessionDescriptor {
    return {
      ref: session.ref,
      provider: session.provider,
      state: session.state,
      revision: session.revision,
      capabilities: { ...session.capabilities },
      ...(session.title ? { title: session.title } : {}),
    };
  }
}
