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

export type GatewayEventType =
  | "session.list"
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
