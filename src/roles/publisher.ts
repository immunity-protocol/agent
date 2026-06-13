import type { AntibodySeed, PublishInput } from "@immunity-protocol/sdk";
import type { Strategy, StrategyContext } from "../strategy.js";
import { type ThreatCandidate, loadThreats } from "./threats.js";
import { selfCheck } from "./self-check.js";

/**
 * publisher — classify candidate threats and `publish()` them as ADDRESS
 * antibodies, staking the bond. Threats come from `AGENT_THREAT_FEED` (a JSON
 * file) or the built-in sample. Each candidate is published at most once per
 * process (it is appended to a seen-set). When the feed is exhausted the tick
 * falls back to a periodic self-`check()` so the agent keeps producing
 * telemetry and stays visibly online.
 *
 * Requires a registered + deposited wallet — `prepare()` verifies both and logs
 * a clear remediation message if either is missing (it does NOT auto-register or
 * auto-deposit: that spends the operator's funds and is an explicit operator
 * action — see README).
 */
export class PublisherStrategy implements Strategy {
  readonly role = "publisher";
  #threats: ThreatCandidate[] = [];
  #cursor = 0;
  #ready = false;

  async prepare(ctx: StrategyContext): Promise<void> {
    this.#threats = await loadThreats(process.env.AGENT_THREAT_FEED?.trim() || undefined);
    ctx.log.info("loaded threat feed", { count: this.#threats.length });

    const registered = await ctx.im.isRegistered();
    if (!registered) {
      ctx.log.warn(
        "wallet is NOT a registered publisher — publishing is disabled. Register first: see README 'bring a funded wallet'.",
      );
      return;
    }
    const balance = await ctx.im.balanceOf();
    if (balance <= 0n) {
      ctx.log.warn(
        "registered, but operator deposit balance is 0 — publishing will fail on the bond. Deposit USDC first (see README).",
        { balance: balance.toString() },
      );
      return;
    }
    this.#ready = true;
    ctx.log.info("publisher ready", { balance: balance.toString() });
  }

  async tick(ctx: StrategyContext): Promise<void> {
    if (!this.#ready || this.#cursor >= this.#threats.length) {
      // Nothing to publish (not ready, or feed exhausted): keep the agent
      // visibly alive + producing check/block telemetry.
      await selfCheck(ctx);
      return;
    }
    const candidate = this.#threats[this.#cursor];
    this.#cursor += 1;
    if (candidate === undefined) return;

    const seed: AntibodySeed = {
      abType: "ADDRESS",
      chainId: candidate.chainId,
      target: candidate.address,
    };
    const input: PublishInput = {
      seed,
      verdict: candidate.verdict,
      confidence: candidate.confidence,
      severity: candidate.severity,
      reasonSummary: candidate.reason,
    };

    try {
      const result = await ctx.im.publish(input);
      ctx.log.info("published antibody", { immId: result.immId, target: candidate.address });
      ctx.record({
        actionType: "publish",
        actionSummary: `Published ${candidate.verdict} ADDRESS antibody for ${candidate.address}`,
        status: "info",
        antibodyImmId: result.immId,
        txHash: result.txHash,
        target: candidate.address,
        family: candidate.family ?? null,
      });
    } catch (err) {
      ctx.log.error("publish failed", { target: candidate.address, error: String(err) });
      ctx.record({
        actionType: "publish",
        actionSummary: `Publish failed for ${candidate.address}: ${String(err)}`,
        status: "error",
        target: candidate.address,
        family: candidate.family ?? null,
      });
    }
  }
}
