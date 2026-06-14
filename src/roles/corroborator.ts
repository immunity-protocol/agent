import type { AntibodySeed, CheckContext, ProposedTx, PublishInput } from "@immunity-protocol/sdk";
import type { Strategy, StrategyContext } from "../strategy.js";
import { type ThreatCandidate, loadThreats } from "./threats.js";
import { selfCheck } from "./self-check.js";

/**
 * corroborator — on a tick, `check()` a sample action; when the check surfaces
 * an advisory/novel hit the agent deems real, `corroborate()` it (publish the
 * same seed under THIS wallet, driving the matcher toward maturation at
 * corroboration ≥ K).
 *
 * For the template the "sample action" is a transfer to a candidate address
 * drawn from the same threat feed the publisher uses — so a freshly-published
 * advisory antibody is exactly what the corroborator's check will surface,
 * which is the maturation path we want to exercise. A real corroborator would
 * re-verify independently (e.g. via CRE) before corroborating; here the
 * heuristic is "the check flagged it (cache/registry/tee) → corroborate".
 *
 * Requires a registered + deposited wallet (corroborate stakes a bond, same as
 * publish). `prepare()` verifies both and disables corroboration with a clear
 * message if either is missing.
 */
export class CorroboratorStrategy implements Strategy {
  readonly role = "corroborator";
  #threats: ThreatCandidate[] = [];
  #cursor = 0;
  #ready = false;

  async prepare(ctx: StrategyContext): Promise<void> {
    this.#threats = await loadThreats(process.env.AGENT_THREAT_FEED?.trim() || undefined);

    const registered = await ctx.im.isRegistered();
    if (!registered) {
      ctx.log.warn(
        "wallet is NOT a registered publisher — corroboration is disabled (self-checks only). Register first (see README).",
      );
      return;
    }
    const balance = await ctx.im.balanceOf();
    if (balance <= 0n) {
      ctx.log.warn(
        "registered, but deposit balance is 0 — corroboration will fail on the bond. Deposit USDC first (see README).",
        { balance: balance.toString() },
      );
      return;
    }
    this.#ready = true;
    ctx.log.info("corroborator ready", { feed: this.#threats.length, balance: balance.toString() });
  }

  readonly #seenPeer = new Set<string>();

  async tick(ctx: StrategyContext): Promise<void> {
    if (!this.#ready) {
      await selfCheck(ctx);
      return;
    }
    // Prefer corroborating a peer's threat of ANY type (the maturation engine:
    // distinct publishers strengthen a matcher toward ACTIVE). Falls through to
    // the local ADDRESS feed when there's no fresh peer antibody to corroborate.
    if (await this.#corroboratePeer(ctx)) return;
    if (this.#threats.length === 0) {
      await selfCheck(ctx);
      return;
    }
    const candidate = this.#threats[this.#cursor % this.#threats.length];
    this.#cursor += 1;
    if (candidate === undefined) return;

    const tx: ProposedTx = {
      to: candidate.address,
      value: 0n,
      chainId: candidate.chainId,
    };
    const context: CheckContext = {
      metadata: { source: "immunity-agent/corroborator", family: candidate.family ?? null },
    };

    let flagged = false;
    try {
      const result = await ctx.im.check(tx, context);
      // A real hit (cache/registry/tee) OR an advisory novel result we deem
      // real is the corroboration trigger.
      flagged =
        result.decision === "block" ||
        result.source === "registry" ||
        result.source === "cache" ||
        (result.novel && result.source === "tee");
      ctx.record({
        actionType: "check",
        actionSummary: `Corroborator check ${result.decision} on ${candidate.address} (source=${result.source})`,
        status: result.decision === "block" ? "block" : result.novel ? "novel" : "allow",
        txHash: result.checkId,
        target: candidate.address,
        antibodyImmId: result.antibodies[0]?.immId ?? null,
        family: candidate.family ?? null,
      });
    } catch (err) {
      ctx.log.warn("corroborator check failed", { target: candidate.address, error: String(err) });
      ctx.record({
        actionType: "check",
        actionSummary: `Corroborator check failed on ${candidate.address}: ${String(err)}`,
        status: "error",
        target: candidate.address,
      });
      return;
    }

    if (!flagged) return;

    const input: PublishInput = {
      seed: { abType: "ADDRESS", chainId: candidate.chainId, target: candidate.address },
      verdict: candidate.verdict,
      confidence: candidate.confidence,
      severity: candidate.severity,
      reasonSummary: `Corroborated: ${candidate.reason}`,
    };
    try {
      const result = await ctx.im.corroborate(input);
      ctx.log.info("corroborated antibody", { immId: result.immId, target: candidate.address });
      ctx.record({
        actionType: "corroborate",
        actionSummary: `Corroborated antibody for ${candidate.address}`,
        status: "info",
        antibodyImmId: result.immId,
        txHash: result.txHash,
        target: candidate.address,
        family: candidate.family ?? null,
      });
    } catch (err) {
      ctx.log.error("corroborate failed", { target: candidate.address, error: String(err) });
      ctx.record({
        actionType: "corroborate",
        actionSummary: `Corroborate failed for ${candidate.address}: ${String(err)}`,
        status: "error",
        target: candidate.address,
      });
    }
  }

  /**
   * Corroborate a peer's threat of ANY type — the maturation engine. Pulls a
   * recent probation antibody published by another agent, reconstructs the SAME
   * matcher seed from its public matcher summary, and corroborates it, adding a
   * distinct publisher to the corroboration set so the antibody matures.
   *
   * The original mint is already attested (a publisher's classification or the
   * trader's CRE Tier-3 verdict), so corroboration here is a distinct staking
   * publisher confirming it — it does NOT re-run the CRE per corroboration (that
   * would serialize the whole fleet behind one verifier and re-infer an identical
   * input). Works identically for ADDRESS / CALL_PATTERN / SEMANTIC.
   *
   * Returns true when it acted (so the caller skips the ADDRESS feed this tick).
   */
  async #corroboratePeer(ctx: StrategyContext): Promise<boolean> {
    if (ctx.cfg.apiUrl === undefined) return false;
    const row = await this.#pickPeer(ctx);
    if (row === undefined) return false;
    this.#seenPeer.add(row.keccak_id);

    const seed = this.#seedFromRow(row);
    if (seed === undefined) return false;

    const input: PublishInput = {
      seed,
      verdict: "MALICIOUS",
      confidence: row.confidence ?? 90,
      severity: row.severity ?? 80,
      reasonSummary: `Corroborated ${row.imm_id}: a distinct publisher confirming this ${row.type} threat`,
    };
    try {
      const result = await ctx.im.corroborate(input);
      ctx.log.info("corroborated peer antibody", { immId: result.immId, peer: row.imm_id, type: row.type });
      ctx.record({
        actionType: "corroborate",
        actionSummary: `Corroborated ${row.type.toUpperCase()} threat ${row.imm_id} — a distinct publisher strengthened the matcher`,
        status: "info",
        antibodyImmId: result.immId,
        txHash: result.txHash,
        family: row.type,
      });
      // Permissionless poke: once the matcher has K corroborating publishers it's
      // mature — promote the peer PROBATION→ACTIVE so it hard-blocks. Reverts
      // NotYet() (caught) if it isn't mature yet.
      try {
        await ctx.im.mature(row.keccak_id);
        ctx.log.info("matured peer antibody", { peer: row.imm_id, type: row.type });
      } catch {
        /* not yet mature (corroboration < K) — a later corroboration will trip it */
      }
    } catch (err) {
      ctx.log.error("peer corroborate failed", { peer: row.imm_id, error: String(err) });
    }
    return true;
  }

  /** Reconstruct an AntibodySeed from a peer antibody's public matcher summary. */
  #seedFromRow(row: PeerRow): AntibodySeed | undefined {
    const m = row.primary_matcher;
    if (m === null || m === undefined) return undefined;
    switch (m.kind) {
      case "address":
        if (!m.target || m.chainId === undefined) return undefined;
        return { abType: "ADDRESS", chainId: m.chainId, target: m.target as `0x${string}` };
      case "call_pattern":
        if (!m.target || m.chainId === undefined || !m.selector || !m.argsTemplate) return undefined;
        return {
          abType: "CALL_PATTERN",
          chainId: m.chainId,
          target: m.target as `0x${string}`,
          selector: m.selector as `0x${string}`,
          argsTemplate: m.argsTemplate as `0x${string}`,
        };
      case "semantic": {
        const flavor = (m.flavor ?? row.flavor ?? "").toUpperCase();
        if (!m.markerHint) return undefined;
        if (flavor !== "COUNTERPARTY" && flavor !== "MANIPULATION" && flavor !== "PROMPT_INJECTION") {
          return undefined;
        }
        return { abType: "SEMANTIC", flavor, pattern: { kind: "marker", value: m.markerHint } };
      }
      // BYTECODE / GRAPH need off-chain matcher enrichment not in the summary; skip.
      default:
        return undefined;
    }
  }

  /** A recent probation antibody (any type) this corroborator didn't publish + hasn't seen. */
  async #pickPeer(ctx: StrategyContext): Promise<PeerRow | undefined> {
    const base = ctx.cfg.apiUrl?.replace(/\/$/, "");
    try {
      const res = await fetch(`${base}/v1/antibodies?status=probation&limit=30`);
      if (!res.ok) return undefined;
      const body = (await res.json()) as { items?: PeerRow[] };
      const items = Array.isArray(body.items) ? body.items : [];
      const own = ctx.wallet.toLowerCase();
      return items.find(
        (r) =>
          !this.#seenPeer.has(r.keccak_id) &&
          (r.publisher ?? "").toLowerCase() !== own &&
          this.#seedFromRow(r) !== undefined,
      );
    } catch {
      return undefined;
    }
  }
}

interface PeerRow {
  keccak_id: string;
  imm_id: string;
  type: string;
  flavor?: string | null;
  confidence?: number;
  severity?: number;
  publisher?: string;
  primary_matcher?: {
    kind?: string;
    target?: string;
    chainId?: number;
    selector?: string;
    argsTemplate?: string;
    markerHint?: string;
    flavor?: string;
  } | null;
}
