import type { CheckContext, ProposedTx, PublishInput } from "@immunity-protocol/sdk";
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

  readonly #seenSemantic = new Set<string>();

  async tick(ctx: StrategyContext): Promise<void> {
    if (!this.#ready) {
      await selfCheck(ctx);
      return;
    }
    // Prefer corroborating a peer's SEMANTIC threat (the maturation engine for
    // injection antibodies). Falls through to the ADDRESS feed when there's none.
    if (await this.#corroborateSemantic(ctx)) return;
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
   * Corroborate a peer's SEMANTIC threat — the maturation engine for injection
   * antibodies. Pulls a recent probation SEMANTIC antibody published by another
   * agent and corroborates the SAME matcher by its exact marker, adding a
   * distinct publisher to the corroboration set so the antibody matures.
   *
   * The original mint is already CRE-attested (the trader's Tier-3 verdict), so
   * corroboration here is a distinct staking publisher confirming it — it does
   * NOT re-run the CRE per corroboration (that would serialize the whole fleet
   * behind one verifier and re-infer an identical input).
   *
   * Returns true when it acted (so the caller skips the ADDRESS path this tick).
   */
  async #corroborateSemantic(ctx: StrategyContext): Promise<boolean> {
    if (ctx.cfg.apiUrl === undefined) return false;
    const row = await this.#pickSemantic(ctx);
    if (row === undefined) return false;
    this.#seenSemantic.add(row.keccak_id);

    const marker = row.primary_matcher?.markerHint;
    const flavor = this.#flavorOf(row);
    if (marker === undefined || marker === "" || flavor === undefined) return false;

    const input: PublishInput = {
      seed: { abType: "SEMANTIC", flavor, pattern: { kind: "marker", value: marker } },
      verdict: "MALICIOUS",
      confidence: row.confidence ?? 90,
      severity: row.severity ?? 80,
      reasonSummary: `Corroborated ${row.imm_id}: a distinct publisher confirming this injection marker`,
    };
    try {
      const result = await ctx.im.corroborate(input);
      ctx.log.info("corroborated SEMANTIC antibody", { immId: result.immId, peer: row.imm_id });
      ctx.record({
        actionType: "corroborate",
        actionSummary: `Corroborated SEMANTIC threat ${row.imm_id} — a distinct publisher strengthened the matcher`,
        status: "info",
        antibodyImmId: result.immId,
        txHash: result.txHash,
        family: "semantic",
      });
      // Permissionless poke: once the matcher has K corroborating publishers it's
      // mature — promote the peer PROBATION→ACTIVE so it hard-blocks. Reverts
      // NotYet() (caught) if it isn't mature yet.
      try {
        await ctx.im.mature(row.keccak_id);
        ctx.log.info("matured SEMANTIC antibody", { peer: row.imm_id });
      } catch {
        /* not yet mature (corroboration < K) — a later corroboration will trip it */
      }
    } catch (err) {
      ctx.log.error("semantic corroborate failed", { peer: row.imm_id, error: String(err) });
    }
    return true;
  }

  /** Map a feed row's flavor string to the SDK SemanticFlavor enum. */
  #flavorOf(row: SemanticRow): "COUNTERPARTY" | "MANIPULATION" | "PROMPT_INJECTION" | undefined {
    const f = (row.flavor ?? row.primary_matcher?.flavor ?? "").toUpperCase();
    if (f === "COUNTERPARTY" || f === "MANIPULATION" || f === "PROMPT_INJECTION") return f;
    return undefined;
  }

  /** A recent probation SEMANTIC antibody this corroborator didn't publish + hasn't seen. */
  async #pickSemantic(ctx: StrategyContext): Promise<SemanticRow | undefined> {
    const base = ctx.cfg.apiUrl?.replace(/\/$/, "");
    try {
      const res = await fetch(`${base}/v1/antibodies?type=semantic&status=probation&limit=20`);
      if (!res.ok) return undefined;
      const body = (await res.json()) as { items?: SemanticRow[] };
      const items = Array.isArray(body.items) ? body.items : [];
      const own = ctx.wallet.toLowerCase();
      return items.find(
        (r) =>
          !this.#seenSemantic.has(r.keccak_id) &&
          (r.publisher ?? "").toLowerCase() !== own &&
          (r.primary_matcher?.markerHint ?? "") !== "",
      );
    } catch {
      return undefined;
    }
  }
}

interface SemanticRow {
  keccak_id: string;
  imm_id: string;
  flavor?: string | null;
  confidence?: number;
  severity?: number;
  publisher?: string;
  primary_matcher?: { markerHint?: string; flavor?: string } | null;
}
