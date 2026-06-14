import type { Strategy, StrategyContext } from "../strategy.js";
import { type FeedItem, pickFeedItem, toPublishInput } from "../data/feed.js";
import { selfCheck } from "./self-check.js";

/**
 * publisher — reads the curated threat-intel feed (data/feed.json) and, when a
 * post carries something concrete (a full address or a quoted injection marker),
 * stakes an antibody for it. Benign / noise / false-positive-bait posts yield
 * nothing — the publisher just does a self-check that tick. So each tick the
 * publisher either publishes from the feed or does nothing of consequence.
 *
 * Duplicates a peer already published surface as AntibodyExists and are picked
 * up by corroborators (→ maturation). Requires a registered + deposited wallet.
 */
export class PublisherStrategy implements Strategy {
  readonly role = "publisher";
  #ready = false;

  async prepare(ctx: StrategyContext): Promise<void> {
    if (!(await ctx.im.isRegistered())) {
      ctx.log.warn("wallet is NOT a registered publisher — publishing disabled (see README).");
      return;
    }
    const balance = await ctx.im.balanceOf();
    if (balance <= 0n) {
      ctx.log.warn("registered, but operator deposit is 0 — publishing will fail on the bond.", {
        balance: balance.toString(),
      });
      return;
    }
    this.#ready = true;
    ctx.log.info("publisher ready", { balance: balance.toString() });
  }

  async tick(ctx: StrategyContext): Promise<void> {
    if (!this.#ready) {
      await selfCheck(ctx);
      return;
    }
    const item = pickFeedItem();
    const input = toPublishInput(item);
    if (input === null) {
      // Benign / noise post — nothing to stake. Keep telemetry alive.
      await selfCheck(ctx);
      return;
    }

    const label = describe(item, input.seed.abType);
    try {
      const result = await ctx.im.publish(input);
      ctx.log.info("published antibody", { immId: result.immId, seed: label });
      ctx.record({
        actionType: "publish",
        actionSummary: `Published ${input.verdict} ${input.seed.abType} antibody from ${item.source} intel — ${label}`,
        status: "info",
        antibodyImmId: result.immId,
        txHash: result.txHash,
        family: item.ground_truth_hint,
      });
    } catch (err) {
      const msg = String(err);
      // AntibodyExists (selector 0x7d8c8a75) from a peer is expected → corroboration.
      const dup = /AntibodyExists|already|0x7d8c8a75/i.test(msg);
      ctx.log[dup ? "debug" : "error"]("publish outcome", { seed: label, error: msg });
      if (!dup) {
        ctx.record({
          actionType: "publish",
          actionSummary: `Publish failed — ${label}: ${msg.slice(0, 120)}`,
          status: "error",
          family: item.ground_truth_hint,
        });
      }
    }
  }
}

function describe(item: FeedItem, abType: string): string {
  if (abType === "ADDRESS") {
    const m = item.content.match(/0x[0-9a-fA-F]{40}/);
    return m ? m[0] : item.id;
  }
  const q = item.content.match(/'([^']{6,140})'/)?.[1];
  return q ? `"${q.slice(0, 40)}"` : item.id;
}
