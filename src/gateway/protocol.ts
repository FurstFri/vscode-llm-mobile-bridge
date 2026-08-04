import type { Provider } from "../model.js";

export type SessionState = "idle" | "busy" | "host_offline" | "conflict";
export type SessionRevision = string | number;

export interface SessionCapabilities {
  canRead: boolean;
  canStartTurn: boolean;
  canApprove: boolean;
}

export interface SessionDescriptor {
  ref: string;
  provider: Provider;
  state: SessionState;
  revision: SessionRevision;
  capabilities: SessionCapabilities;
  title?: string;
  /** Project folder name only; full workspace paths never leave the gateway. */
  project?: string;
  updatedAt?: number;
}

export interface TimelineItem {
  id: string;
  kind: "message" | "reasoning" | "tool";
  role?: "user" | "assistant";
  text?: string;
  status?: "pending" | "running" | "completed" | "failed";
  /** Epoch milliseconds of the underlying provider event, when known. */
  at?: number;
}

export interface SessionSnapshot {
  session: SessionDescriptor;
  items: TimelineItem[];
}

/** A model the provider currently offers, as reported by the provider itself. */
export interface ProviderModel {
  /** Value passed back as the turn's `model` override. */
  id: string;
  label: string;
  description?: string;
  /** Effort levels this model accepts, in provider order. */
  efforts: string[];
  defaultEffort?: string;
  isDefault?: boolean;
}

/** Subscription usage for a provider, as far as it reports one. */
export interface ProviderLimits {
  /** Share of the current window already used, 0..100. */
  usedPercent?: number;
  /** Unix seconds when the window resets. */
  resetsAt?: number;
  /** Length of the usage window in minutes (e.g. 10080 for a week). */
  windowMinutes?: number;
  plan?: string;
  status?: "allowed" | "warning" | "rejected";
  /** Why the number is missing or stale, when it is. */
  note?: string;
}

export interface ProviderStatus {
  provider: Provider;
  models: ProviderModel[];
  limits?: ProviderLimits;
}

export type GatewayEventType =
  | "session.list"
  | "provider.status"
  | "session.snapshot"
  | "session.state"
  | "session.conflict"
  | "session.new"
  | "session.resume"
  | "turn.start"
  | "turn.cancel"
  | "turn.status"
  | "item.add"
  | "item.delta"
  | "item.complete"
  | "tool.request"
  | "tool.progress"
  | "tool.complete"
  | "approval.request"
  | "approval.respond"
  | "error";

export interface GatewayEvent<TPayload = unknown> {
  protocolVersion: 1;
  messageId: string;
  correlationId: string;
  sessionRef: string;
  sequence: number;
  type: GatewayEventType;
  payload: TPayload;
}

export interface WriterLease {
  readonly sessionRef: string;
  readonly owner: string;
  release(): void;
}
