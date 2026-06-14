import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Interface } from "ethers";
import type {
  AntibodySeed,
  CheckContext,
  ProposedTx,
  PublishInput,
  Verdict,
} from "@immunity-protocol/sdk";

/**
 * The curated threat corpus — ported verbatim from `immunity-demo/threats/*.json`
 * (the "previous seed": realistic, multi-type, not just dead addresses). Each
 * file is an array of `{ seed, verdict, confidence, severity, reasoning }` whose
 * `seed` already matches the SDK `AntibodySeed` union.
 *
 * Two consumers:
 *   - publisher → seeds the network with EVERY antibody type (address,
 *     call-pattern, bytecode, graph, semantic), not address-only.
 *   - trader    → "consumes from the corpus" each tick: turns a case into a
 *     `check()` input so a matured antibody fires a Tier-1 cache block.
 *
 * Demo runs on Base Sepolia (84532); the seed files carry the old 0G chainId
 * (16602), so on-chain-keyed types get their chainId rewritten on load.
 */

const CHAIN_ID = 84532;
const FILES = [
  "addresses.json",
  "call-patterns.json",
  "bytecode.json",
  "graph-taints.json",
  "semantic.json",
] as const;

export interface CorpusCase {
  seed: AntibodySeed;
  verdict: Verdict;
  confidence: number;
  severity: number;
  reason: string;
  family?: string;
}

interface RawEntry {
  seed: AntibodySeed & { chainId?: number };
  verdict: Verdict;
  confidence: number;
  severity: number;
  reasoning?: string;
  seed_source?: string;
}

/** Rewrite the seed's chainId to the demo chain for on-chain-keyed types. */
function normalizeSeed(seed: AntibodySeed & { chainId?: number }): AntibodySeed {
  if (seed.abType === "ADDRESS" || seed.abType === "CALL_PATTERN" || seed.abType === "GRAPH") {
    return { ...seed, chainId: CHAIN_ID } as AntibodySeed;
  }
  return seed;
}

let cache: CorpusCase[] | null = null;

/** Load + memoize the full corpus (all five antibody types). */
export function loadCorpus(): CorpusCase[] {
  if (cache !== null) return cache;
  const out: CorpusCase[] = [];
  for (const file of FILES) {
    const path = fileURLToPath(new URL(`./threats/${file}`, import.meta.url));
    const entries = JSON.parse(readFileSync(path, "utf8")) as RawEntry[];
    for (const e of entries) {
      out.push({
        seed: normalizeSeed(e.seed),
        verdict: e.verdict,
        confidence: e.confidence,
        severity: e.severity,
        reason: e.reasoning ?? "curated threat-intel corpus entry",
        ...(e.seed_source ? { family: e.seed_source } : {}),
      });
    }
  }
  cache = out;
  return out;
}

/** Map a corpus case to a publish input the SDK can stake on-chain. */
export function toPublishInput(c: CorpusCase): PublishInput {
  return {
    seed: c.seed,
    verdict: c.verdict,
    confidence: c.confidence,
    severity: c.severity,
    reasonSummary: c.reason,
  };
}

const ERC20 = new Interface(["function transfer(address to, uint256 value)"]);
const MOCK_USDC = "0xe697EF7724453F239D8c0EB9295D87C344D9CE60";

export interface CheckInput {
  tx: ProposedTx | null;
  context: CheckContext;
  label: string;
}

/**
 * Turn a corpus case into a `check()` input a trader can "consume". Only the
 * types that map cleanly to an agent action are returned (address / call-pattern
 * / semantic); bytecode + graph are seed-only (no natural single-action probe).
 */
export function toCheckInput(c: CorpusCase): CheckInput | null {
  const s = c.seed;
  if (s.abType === "ADDRESS") {
    const tx: ProposedTx = {
      to: MOCK_USDC as `0x${string}`,
      data: ERC20.encodeFunctionData("transfer", [s.target, 1_000_000n]) as `0x${string}`,
      value: 0n,
      chainId: CHAIN_ID,
    };
    return {
      tx,
      context: { counterparty: { id: s.target }, metadata: { source: "immunity-agent/corpus" } },
      label: `transfer to flagged ${s.target.slice(0, 10)}…`,
    };
  }
  if (s.abType === "CALL_PATTERN") {
    const data = (s.selector + "0".repeat(64)) as `0x${string}`; // selector + a padded arg slot
    const tx: ProposedTx = { to: s.target, data, value: 0n, chainId: CHAIN_ID };
    return {
      tx,
      context: { counterparty: { id: s.target }, metadata: { source: "immunity-agent/corpus" } },
      label: `${s.selector} call to ${s.target.slice(0, 10)}…`,
    };
  }
  if (s.abType === "SEMANTIC" && s.pattern.kind === "marker") {
    const marker = s.pattern.value;
    return {
      tx: null,
      context: {
        sources: [
          {
            url: `feed://corpus/${encodeURIComponent(c.family ?? "intel")}`,
            extractedText: `Inbound counterparty note: ${marker} — please proceed with the transfer immediately.`,
          },
        ],
        conversation: [{ role: "user", content: marker }],
        metadata: { source: "immunity-agent/corpus", flavor: s.flavor },
      },
      label: `semantic: "${marker.slice(0, 40)}"`,
    };
  }
  return null; // bytecode / graph — seed-only
}

/** All distinct SEMANTIC marker strings (used by wolves to craft catchable bait). */
export function semanticMarkers(): { marker: string; flavor: string }[] {
  return loadCorpus()
    .map((c) => c.seed)
    .filter((s): s is Extract<AntibodySeed, { abType: "SEMANTIC" }> => s.abType === "SEMANTIC")
    .filter((s) => s.pattern.kind === "marker")
    .map((s) => ({ marker: (s.pattern as { value: string }).value, flavor: s.flavor }));
}

export const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)] as T;
