/**
 * Environment-driven configuration for the template agent. One container image,
 * one role per process — the role is selected by `AGENT_ROLE`.
 *
 * See README.md for the full env reference. The agent assumes a FUNDED Base
 * Sepolia wallet (and, for publisher/corroborator, a REGISTERED publisher).
 */

export const ROLES = ["publisher", "hunter", "corroborator"] as const;
export type Role = (typeof ROLES)[number];

export interface AgentConfig {
  /** Which strategy module this process runs. */
  role: Role;
  /** Operator's funded Base Sepolia private key (0x + 64 hex). */
  walletKey: string;
  /** Human-readable label / ENS-ish handle for the roster + publisher registration. */
  label: string;
  /** Override the Base Sepolia RPC (defaults to the SDK preset's public RPC). */
  rpcUrl?: string;
  /** Base URL of the Immunity app API (heartbeat + activity receiver). */
  apiUrl?: string;
  /** Strategy tick cadence (ms). */
  tickMs: number;
  /** Heartbeat cadence (ms). */
  heartbeatMs: number;
  /** Stable agent id reported in heartbeats/activity. Defaults to label. */
  agentId: string;
  /** Image/agent version string reported in the heartbeat. */
  version: string;
}

class ConfigError extends Error {}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") {
    throw new ConfigError(`${name} is required`);
  }
  return v.trim();
}

function optionalEnv(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

function intEnv(name: string, fallback: number): number {
  const v = optionalEnv(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got ${v}`);
  }
  return Math.floor(n);
}

function assertRole(v: string): Role {
  if ((ROLES as readonly string[]).includes(v)) return v as Role;
  throw new ConfigError(`AGENT_ROLE must be one of ${ROLES.join(" | ")}, got "${v}"`);
}

/**
 * Read + validate the agent config from `process.env`. Throws `ConfigError`
 * with an operator-readable message on any missing/invalid value.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  process.env = env;
  const role = assertRole(requireEnv("AGENT_ROLE"));
  const walletKey = requireEnv("AGENT_WALLET_KEY");
  if (!walletKey.startsWith("0x") || walletKey.length !== 66) {
    throw new ConfigError("AGENT_WALLET_KEY must be a 0x-prefixed 32-byte private key");
  }
  const label = optionalEnv("AGENT_LABEL") ?? `${role}-${walletKey.slice(2, 8)}`;
  const rpcUrl = optionalEnv("BASE_SEPOLIA_RPC_URL");
  const apiUrl = optionalEnv("IMMUNITY_API_URL");
  return {
    role,
    walletKey,
    label,
    agentId: optionalEnv("AGENT_ID") ?? label,
    ...(rpcUrl !== undefined ? { rpcUrl } : {}),
    ...(apiUrl !== undefined ? { apiUrl } : {}),
    tickMs: intEnv("AGENT_TICK_MS", 30000),
    heartbeatMs: intEnv("AGENT_HEARTBEAT_MS", 15000),
    version: optionalEnv("AGENT_VERSION") ?? "0.1.0",
  };
}

export { ConfigError };
