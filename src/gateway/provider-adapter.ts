import type { Provider } from "../model.js";
import type {
  GatewayEventType,
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

export interface ProviderAdapter {
  readonly provider: Provider;
  listSessions(): Promise<readonly ProviderSessionSummary[]>;
  readSnapshot(providerSessionId: string): Promise<ProviderSessionSnapshot>;
  startTurn(providerSessionId: string, text: string): AsyncIterable<ProviderTurnEvent>;
}
