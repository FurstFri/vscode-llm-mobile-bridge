export type Provider = "claude" | "codex";

export type ProbeStatus = "ready" | "unavailable" | "blocked" | "failed";

export interface ProbeResult {
  provider: Provider;
  status: ProbeStatus;
  summary: string;
  evidence: Record<string, string | number | boolean>;
  nextStep?: string;
}

export interface ProviderProbe {
  readonly provider: Provider;
  run(): Promise<ProbeResult>;
}
