import type { CheckContext, ProposedTx } from "@immunity-protocol/sdk";
import type { StrategyContext } from "../strategy.js";

/**
 * Run a periodic `check()` against the agent's OWN activity. Every role does
 * this so the fleet produces real check/block/value-protected telemetry (the
 * dashboard renders it). The probe is a benign self-transfer-ish action against
 * the agent's own wallet — deliberately innocuous so it normally returns
 * `allow`; if it ever hits an antibody the result is recorded as `block`.
 *
 * `check()` settles a fee on-chain, so this only runs when the operator balance
 * can cover it; a thrown error is recorded as `error` and never breaks the loop.
 */
export async function selfCheck(ctx: StrategyContext): Promise<void> {
  const tx: ProposedTx = {
    to: ctx.wallet as `0x${string}`,
    value: 0n,
    chainId: 84532,
  };
  const context: CheckContext = {
    metadata: { source: "immunity-agent/self-check", role: ctx.cfg.role },
  };

  try {
    const result = await ctx.im.check(tx, context);
    const status = result.decision === "block" ? "block" : result.novel ? "novel" : "allow";
    ctx.log.debug("self-check", { decision: result.decision, source: result.source });
    ctx.record({
      actionType: "check",
      actionSummary: `Self-check ${result.decision} (source=${result.source})`,
      status,
      txHash: result.checkId,
      antibodyImmId: result.antibodies[0]?.immId ?? null,
    });
  } catch (err) {
    ctx.log.warn("self-check failed", { error: String(err) });
    ctx.record({
      actionType: "check",
      actionSummary: `Self-check failed: ${String(err)}`,
      status: "error",
    });
  }
}
