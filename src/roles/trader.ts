import type { CheckContext, ProposedTx } from "@immunity-protocol/sdk";
import type { Strategy, StrategyContext } from "../strategy.js";
import { selfCheck } from "./self-check.js";
import { type CheckInput, type CorpusCase, loadCorpus, pick, toCheckInput } from "../data/corpus.js";

/**
 * trader — a treasury agent going about its day. Each (randomly-paced) tick it
 * does ONE of three things, weighted, so the fleet reads as organic activity and
 * not a synchronized attack:
 *
 *   - TRADE  (default ~50%): a normal on-chain action (transfer/clean or to a
 *     flagged drainer) via the shared selfCheck — produces check/block/value
 *     telemetry.
 *   - FEED   (~30%): scrolls the social feed and consumes one post (good OR bad).
 *     A poisoned post (wolf-planted) trips the SemanticMatcher → block; a novel
 *     one escalates to the CRE verifier and, if confirmed, mints an antibody.
 *   - CORPUS (~20%): "consumes" a curated realistic attack from the threat corpus
 *     (data/threats/*) — a matured antibody fires a Tier-1 cache block.
 *
 * Weights are tunable: AGENT_TRADER_TRADE / _FEED / _CORPUS (need not sum to 1;
 * they're normalized). Requires a registered + funded wallet to mint/settle.
 */
export class TraderStrategy implements Strategy {
  readonly role = "trader";
  #ready = false;
  #feedUrl = "http://127.0.0.1:8080";
  #corpus: CorpusCase[] = [];
  readonly #seen = new Set<number>();

  async prepare(ctx: StrategyContext): Promise<void> {
    const feed = process.env.AGENT_FEED_URL?.trim();
    if (feed) this.#feedUrl = feed.replace(/\/$/, "");
    this.#corpus = loadCorpus().filter((c) => toCheckInput(c) !== null);

    if (!(await ctx.im.isRegistered())) {
      ctx.log.warn("trader wallet is NOT registered — cannot mint confirmed threats (check-only).");
    }
    const balance = await ctx.im.balanceOf().catch(() => 0n);
    this.#ready = true;
    ctx.log.info("trader ready", { feed: this.#feedUrl, corpus: this.#corpus.length, balance: balance.toString() });
  }

  async tick(ctx: StrategyContext): Promise<void> {
    if (!this.#ready) return;
    const mode = this.#pickMode();
    if (mode === "trade") {
      await selfCheck(ctx);
      return;
    }
    if (mode === "corpus") {
      await this.#consumeCorpus(ctx);
      return;
    }
    await this.#consumeFeed(ctx);
  }

  #pickMode(): "trade" | "feed" | "corpus" {
    const w = {
      trade: num(process.env.AGENT_TRADER_TRADE, 0.5),
      feed: num(process.env.AGENT_TRADER_FEED, 0.3),
      corpus: num(process.env.AGENT_TRADER_CORPUS, 0.2),
    };
    const total = w.trade + w.feed + w.corpus || 1;
    let r = Math.random() * total;
    if ((r -= w.trade) < 0) return "trade";
    if ((r -= w.feed) < 0) return "feed";
    return "corpus";
  }

  /** Consume a curated realistic attack from the threat corpus. */
  async #consumeCorpus(ctx: StrategyContext): Promise<void> {
    if (this.#corpus.length === 0) return void (await selfCheck(ctx));
    const input = toCheckInput(pick(this.#corpus));
    if (input === null) return;
    await this.#runCheck(ctx, input.tx, input.context, {
      summaryAllow: `Vetted a counterparty action (${input.label}) — clean`,
      summaryBlock: `Caught a known threat from the corpus — ${input.label}`,
      label: input.label,
    });
  }

  /** Scroll the feed and consume one post — good or bad, unbiased. */
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
