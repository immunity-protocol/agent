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

  async tick(ctx: StrategyContext): Promise<void> {
    if (!this.#ready || this.#threats.length === 0) {
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
}
