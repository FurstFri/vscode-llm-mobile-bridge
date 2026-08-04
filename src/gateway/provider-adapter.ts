import type { Provider } from "../model.js";
import type {
  GatewayEventType,
  ProviderLimits,
  ProviderModel,
  SessionCapabilities,
  SessionRevision,
  TimelineItem,
} from "./protocol.js";

export interface ProviderSessionSummary {
  providerSessionId: string;
  title?: string;
  capabilities?: SessionCapabilities;
  /** Project folder name only; full workspace paths never leave the gateway. */
  project?: string;
  updatedAt?: number;
}

export interface ProviderSessionSnapshot {
  revision: SessionRevision;
  state: "idle" | "busy";
  items: TimelineItem[];
}

export type ProviderTurnEvent = {
  type: Extract<
    GatewayEventType,
    | "session.new"
    | "turn.status"
    | "item.add"
    | "item.delta"
    | "item.complete"
    | "tool.request"
    | "tool.progress"
    | "tool.complete"
    | "approval.request"
  >;
  payload: unknown;
};

/** Per-turn overrides selected on the phone. */
export interface TurnOptions {
  model?: string;
  effort?: string;
}

/** Payload of the adapter-emitted "session.new" event. */
export interface NewSessionAnnouncement {
  providerSessionId: string;
  title?: string;
  project?: string;
  updatedAt?: number;
}

export interface ProviderAdapter {
  readonly provider: Provider;
  /** Models the provider currently offers, for the phone's picker. */
  listModels(): Promise<readonly ProviderModel[]>;
  /** Subscription usage, when the provider exposes it. */
  readLimits(): Promise<ProviderLimits | undefined>;
  listSessions(): Promise<readonly ProviderSessionSummary[]>;
  readSnapshot(providerSessionId: string): Promise<ProviderSessionSnapshot>;
  startTurn(providerSessionId: string, text: string, options?: TurnOptions): AsyncIterable<ProviderTurnEvent>;
  /** Creates a fresh provider session and runs the first turn. The first
   *  emitted event must be "session.new" with a NewSessionAnnouncement. */
  startNewSession(text: string, options?: TurnOptions): AsyncIterable<ProviderTurnEvent>;
  /**
   * Answers a permission prompt this adapter forwarded to the phone.
   * Returns false when the id is not (or no longer) pending.
   */
  resolveApproval?(id: string, allow: boolean, message?: string): boolean;
}
