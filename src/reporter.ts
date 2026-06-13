import type { AgentConfig } from "./config.js";
import type { Logger } from "./log.js";

/**
 * Liveness + activity reporting to the Immunity app.
 *
 * NOTE: at the time of writing the app exposes NO inbound POST endpoint for
 * agent heartbeats/activity — the old demo fleet wrote straight to Postgres
 * (`demo.agent_heartbeat` / `demo.agent_activity`). The template agent must not
 * touch the database directly, so it POSTs JSON to the app over HTTP. The exact
 * contract below is the one the upcoming `/agents`-page work should implement on
 * the app side (a receiver controller that upserts the heartbeat and appends the
 * activity row). See README "Heartbeat + activity contract".
 *
 * Heartbeat   POST {IMMUNITY_API_URL}/v1/agents/heartbeat
 * Activity    POST {IMMUNITY_API_URL}/v1/agents/activity
 *
 * Both are fire-and-forget: a failed report is logged at warn level and NEVER
 * breaks the agent's loop. If `IMMUNITY_API_URL` is unset the reporter is a
 * no-op (offline / local-only run).
 */

/** Heartbeat payload: one row per agent, upserted on `agent_id`. */
export interface HeartbeatPayload {
  /** Stable per-agent id (upsert key). */
  agentId: string;
  /** publisher | hunter | corroborator. */
  role: string;
  /** Human-readable name for the roster (substitutes for the hex address). */
  displayName: string;
  /** The agent's Base Sepolia wallet address (0x). */
  wallet: string;
  /** Registered ENS name, if any (null until registered). */
  ens: string | null;
  /** Image/agent version string. */
  version: string;
  /** ISO-8601 timestamp the agent emitted this heartbeat. */
  sentAt: string;
}

/**
 * Activity payload: one observable action the agent took. Mirrors the demo
 * `ActivityRecord` shape so the existing dashboard activity panel can render it
 * unchanged (action_type / action_summary / status / antibody_imm_id / tx_hash).
 */
export interface ActivityPayload {
  agentId: string;
  role: string;
  displayName: string;
  /** e.g. check | publish | corroborate | challenge | scan. */
  actionType: string;
  actionSummary: string;
  /** allow | block | novel | error | info. */
  status: "allow" | "block" | "novel" | "error" | "info";
  antibodyImmId?: string | null;
  txHash?: string | null;
  target?: string | null;
  family?: string | null;
  occurredAt: string;
}

export class Reporter {
  readonly #cfg: AgentConfig;
  readonly #log: Logger;
  #wallet: string | null = null;
  #ens: string | null = null;

  constructor(cfg: AgentConfig, log: Logger) {
    this.#cfg = cfg;
    this.#log = log;
  }

  /** Bind the resolved wallet (+ optional ENS) once the SDK has started. */
  bindIdentity(wallet: string, ens: string | null): void {
    this.#wallet = wallet;
    this.#ens = ens;
  }

  get enabled(): boolean {
    return this.#cfg.apiUrl !== undefined;
  }

  async heartbeat(): Promise<void> {
    const payload: HeartbeatPayload = {
      agentId: this.#cfg.agentId,
      role: this.#cfg.role,
      displayName: this.#cfg.label,
      wallet: this.#wallet ?? "0x",
      ens: this.#ens,
      version: this.#cfg.version,
      sentAt: new Date().toISOString(),
    };
    await this.#post("/v1/agents/heartbeat", payload, "heartbeat");
  }

  async activity(rec: Omit<ActivityPayload, "agentId" | "role" | "displayName" | "occurredAt">): Promise<void> {
    const payload: ActivityPayload = {
      agentId: this.#cfg.agentId,
      role: this.#cfg.role,
      displayName: this.#cfg.label,
      occurredAt: new Date().toISOString(),
      ...rec,
    };
    await this.#post("/v1/agents/activity", payload, "activity");
  }

  async #post(path: string, body: unknown, kind: string): Promise<void> {
    if (this.#cfg.apiUrl === undefined) return; // offline / local-only
    const url = `${this.#cfg.apiUrl.replace(/\/$/, "")}${path}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        this.#log.warn(`${kind} report rejected`, { url, status: res.status });
      }
    } catch (err) {
      this.#log.warn(`${kind} report failed`, { url, error: String(err) });
    }
  }
}
