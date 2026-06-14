import type { CheckContext, ProposedTx } from "@immunity-protocol/sdk";
import type { Strategy, StrategyContext } from "../strategy.js";
import { selfCheck } from "./self-check.js";
import { pickFeedItem, toCheckContext } from "../data/feed.js";

/**
 * trader — a treasury agent going about its day. Each (randomly-paced) tick it
 * does ONE of three things, weighted, so the fleet reads as organic activity and
 * not a synchronized attack:
 *
 *   - TRADE  (~40%): a normal on-chain action (transfer/clean or to a flagged
 *     drainer) via the shared selfCheck — produces check/block/value telemetry.
 *   - SOCIAL (~30%): scrolls the fake social feed and consumes one post (good OR
 *     bad). A wolf-planted post trips the SemanticMatcher → block.
 *   - INTEL  (~30%): reads one post from the curated threat-intel feed
 *     (data/feed.json) and check()s it — mostly benign, occasionally a real marker.
 *
 * Weights are tunable: AGENT_TRADER_TRADE / _SOCIAL / _INTEL (normalized).
 * Requires a registered + funded wallet to mint/settle.
 */
export class TraderStrategy implements Strategy {
  readonly role = "trader";
  #ready = false;
  #feedUrl = "http://127.0.0.1:8080";
  readonly #seen = new Set<number>();

  async prepare(ctx: StrategyContext): Promise<void> {
    const feed = process.env.AGENT_FEED_URL?.trim();
    if (feed) this.#feedUrl = feed.replace(/\/$/, "");

    if (!(await ctx.im.isRegistered())) {
      ctx.log.warn("trader wallet is NOT registered — cannot mint confirmed threats (check-only).");
    }
    const balance = await ctx.im.balanceOf().catch(() => 0n);
    this.#ready = true;
    ctx.log.info("trader ready", { social: this.#feedUrl, balance: balance.toString() });
  }

  async tick(ctx: StrategyContext): Promise<void> {
    if (!this.#ready) return;
    const mode = this.#pickMode();
    if (mode === "trade") {
      await selfCheck(ctx);
      return;
    }
    if (mode === "intel") {
      await this.#consumeIntel(ctx);
      return;
    }
    await this.#consumeFeed(ctx);
  }

  #pickMode(): "trade" | "social" | "intel" {
    const w = {
      trade: num(process.env.AGENT_TRADER_TRADE, 0.4),
      social: num(process.env.AGENT_TRADER_SOCIAL, 0.3),
      intel: num(process.env.AGENT_TRADER_INTEL, 0.3),
    };
    const total = w.trade + w.social + w.intel || 1;
    let r = Math.random() * total;
    if ((r -= w.trade) < 0) return "trade";
    if ((r -= w.social) < 0) return "social";
    return "intel";
  }

  /** Read one post from the curated threat-intel feed (feed.json) and check it. */
  async #consumeIntel(ctx: StrategyContext): Promise<void> {
    const item = pickFeedItem();
    await this.#runCheck(ctx, null, toCheckContext(item), {
      summaryAllow: `Read ${item.source} intel — nothing actionable`,
      summaryBlock: `Flagged a threat while reading ${item.source} intel`,
      label: `intel ${item.id}`,
    });
  }

  /** Scroll the fake social feed and consume one post — good or bad, unbiased. */
  async #consumeFeed(ctx: StrategyContext): Promise<void> {
    const post = await this.#randomPost(ctx);
    if (post === undefined) return void (await selfCheck(ctx));
    const context: CheckContext = {
      sources: [{ url: `feed://${post.source}/${post.id}`, extractedText: post.content }],
      conversation: [{ role: "user", content: post.content }],
      metadata: { source: "immunity-agent/trader", family: post.family ?? null, flavor: post.flavor ?? null },
    };
    await this.#runCheck(ctx, null, context, {
      summaryAllow: `Read a ${post.source} post — looks fine`,
      summaryBlock: `Refused a poisoned ${post.source} post`,
      label: `feed post #${post.id}`,
      family: post.family ?? null,
    });
  }

  /** Run a check + record allow/block/mint uniformly. */
  async #runCheck(
    ctx: StrategyContext,
    tx: ProposedTx | null,
    context: CheckContext,
    o: { summaryAllow: string; summaryBlock: string; label: string; family?: string | null },
  ): Promise<void> {
    try {
      const result = await ctx.im.check(tx, context);
      const minted = result.pendingWrite ? await result.pendingWrite.catch(() => null) : null;
      if (minted) {
        ctx.log.info("organic mint from consumed content", { immId: minted.immId, src: o.label });
        ctx.record({
          actionType: "mint",
          actionSummary: `Hit a novel threat (${o.label}) and minted a new antibody — the network is now immune`,
          status: "novel",
          antibodyImmId: minted.immId,
          txHash: minted.txHash,
          family: o.family ?? null,
        });
        return;
      }
      const blocked = result.decision === "block";
      ctx.record({
        actionType: "consume",
        actionSummary: blocked
          ? `${o.summaryBlock} — protected by ${result.antibodies[0]?.immId ?? "an antibody"} (${result.source})`
          : o.summaryAllow,
        status: blocked ? "block" : result.novel ? "novel" : "allow",
        antibodyImmId: result.antibodies[0]?.immId ?? null,
        txHash: result.checkId,
        family: o.family ?? null,
      });
    } catch (err) {
      ctx.log.warn("trader check failed", { src: o.label, error: String(err) });
    }
  }

  /** Fetch a recent page of feed posts and return a random unseen one (unbiased). */
  async #randomPost(ctx: StrategyContext): Promise<FeedPost | undefined> {
    try {
      const res = await fetch(`${this.#feedUrl}/api/v1/feed/posts?before_id=999999999`, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { posts?: FeedPost[] };
      const posts = Array.isArray(body.posts) ? body.posts : [];
      const fresh = posts.filter((p) => !this.#seen.has(p.id));
      const pool = fresh.length > 0 ? fresh : posts;
      if (pool.length === 0) return undefined;
      const choice = pick(pool);
      if (choice) this.#seen.add(choice.id);
      return choice;
    } catch (err) {
      ctx.log.warn("feed fetch failed", { error: String(err) });
      return undefined;
    }
  }
}

function pick<T>(a: T[]): T {
  return a[Math.floor(Math.random() * a.length)] as T;
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

interface FeedPost {
  id: number;
  source: string;
  content: string;
  is_malicious: boolean;
  family?: string | null;
  flavor?: string | null;
}
