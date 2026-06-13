import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Address, Verdict } from "@immunity-protocol/sdk";

/**
 * A candidate threat the publisher classifies + publishes as an ADDRESS
 * antibody. The template ships a tiny built-in sample; operators point
 * `AGENT_THREAT_FEED` at a JSON file (same shape) for a real feed.
 */
export interface ThreatCandidate {
  address: Address;
  chainId: number;
  verdict: Verdict;
  /** 0–100. */
  confidence: number;
  /** 0–100 (scales the publish bond). */
  severity: number;
  reason: string;
  family?: string;
}

const VALID_VERDICTS = new Set<Verdict>(["MALICIOUS", "SUSPICIOUS"]);

function assertCandidate(v: unknown, i: number): ThreatCandidate {
  if (typeof v !== "object" || v === null) throw new Error(`threat[${i}] is not an object`);
  const o = v as Record<string, unknown>;
  if (typeof o.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(o.address)) {
    throw new Error(`threat[${i}].address must be 0x-prefixed 20-byte hex`);
  }
  if (typeof o.verdict !== "string" || !VALID_VERDICTS.has(o.verdict as Verdict)) {
    throw new Error(`threat[${i}].verdict must be MALICIOUS or SUSPICIOUS`);
  }
  const confidence = Number(o.confidence);
  const severity = Number(o.severity);
  if (!Number.isInteger(confidence) || confidence < 0 || confidence > 100) {
    throw new Error(`threat[${i}].confidence must be an integer 0–100`);
  }
  if (!Number.isInteger(severity) || severity < 0 || severity > 100) {
    throw new Error(`threat[${i}].severity must be an integer 0–100`);
  }
  return {
    address: o.address as Address,
    chainId: typeof o.chainId === "number" ? o.chainId : 84532,
    verdict: o.verdict as Verdict,
    confidence,
    severity,
    reason: typeof o.reason === "string" ? o.reason : "no reason provided",
    ...(typeof o.family === "string" ? { family: o.family } : {}),
  };
}

function parseFeed(raw: string): ThreatCandidate[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("threat feed must be a JSON array");
  return parsed.map(assertCandidate);
}

/**
 * Load the threat feed. Order of precedence:
 *   1. `AGENT_THREAT_FEED` — absolute path to a JSON file (operator feed).
 *   2. the built-in `threats.sample.json` (demo default).
 */
export async function loadThreats(feedPath?: string): Promise<ThreatCandidate[]> {
  if (feedPath !== undefined) {
    return parseFeed(await readFile(feedPath, "utf8"));
  }
  const samplePath = fileURLToPath(new URL("./threats.sample.json", import.meta.url));
  return parseFeed(await readFile(samplePath, "utf8"));
}
