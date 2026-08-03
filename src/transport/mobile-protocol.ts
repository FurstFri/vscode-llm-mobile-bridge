import type { GatewayEvent } from "../gateway/protocol.js";

export const MOBILE_PROTOCOL_VERSION = 1 as const;

export type MobileRequest =
  | { protocolVersion: 1; id: string; type: "auth"; token: string }
  | { protocolVersion: 1; id: string; type: "ping" }
  | { protocolVersion: 1; id: string; type: "session.list" }
  | { protocolVersion: 1; id: string; type: "session.snapshot"; sessionRef: string };

export type MobileResponse =
  | { protocolVersion: 1; id: string; ok: true; type: "auth.ready" | "pong" }
  | { protocolVersion: 1; id: string; ok: true; type: "event"; event: GatewayEvent }
  | {
      protocolVersion: 1;
      id: string;
      ok: false;
      type: "error";
      error: { code: "AUTH_REQUIRED" | "AUTH_FAILED" | "INVALID_REQUEST" | "INTERNAL_ERROR"; message: string };
    };
