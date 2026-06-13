import type { Immunity } from "@immunity-protocol/sdk";
import type { AgentConfig } from "./config.js";
import type { Logger } from "./log.js";
import type { ActivityPayload, Reporter } from "./reporter.js";

/** A single observable action, recorded fire-and-forget (never throws). */
export type RecordActivity = (
  rec: Omit<ActivityPayload, "agentId" | "role" | "displayName" | "occurredAt">,
) => void;

/** Everything a role strategy needs to act on a tick. */
export interface StrategyContext {
  cfg: AgentConfig;
  im: Immunity;
  wallet: string;
  log: Logger;
  record: RecordActivity;
}

/**
 * A role strategy is a swappable module: `prepare()` runs once after the SDK is
 * up (registration / deposit checks), `tick()` runs every `AGENT_TICK_MS`.
 */
export interface Strategy {
  readonly role: string;
  /** One-time setup: ensure registered + deposited, etc. Optional. */
  prepare?(ctx: StrategyContext): Promise<void>;
  /** One unit of work. Must not throw — the loop wraps it but be defensive. */
  tick(ctx: StrategyContext): Promise<void>;
}

/** Bind a `Reporter` into the fire-and-forget `RecordActivity` callback. */
export function recordVia(reporter: Reporter, log: Logger): RecordActivity {
  return (rec) => {
    reporter.activity(rec).catch((err) => log.warn("activity record failed", { error: String(err) }));
  };
}
