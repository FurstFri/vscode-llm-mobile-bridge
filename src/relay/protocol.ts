import type { MobileRequest, MobileResponse } from "../transport/mobile-protocol.js";

export const RELAY_PROTOCOL_VERSION = 1 as const;

export type HostToRelayMessage =
  | { relayProtocolVersion: 1; type: "host.register"; token: string }
  | { relayProtocolVersion: 1; type: "mobile.response"; channelId: string; payload: MobileResponse }
  | { relayProtocolVersion: 1; type: "mobile.error"; channelId: string; message: string };

export type RelayToHostMessage =
  | { relayProtocolVersion: 1; type: "host.ready" }
  | { relayProtocolVersion: 1; type: "mobile.open"; channelId: string }
  | { relayProtocolVersion: 1; type: "mobile.request"; channelId: string; payload: Exclude<MobileRequest, { type: "auth" }> }
  | { relayProtocolVersion: 1; type: "mobile.close"; channelId: string };
