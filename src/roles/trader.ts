import type { CheckContext, ProposedTx } from "@immunity-protocol/sdk";
import type { Strategy, StrategyContext } from "../strategy.js";

/**
 * trader — the organic maturation engine. A trader agent randomly consumes the
 * shared corpus (the agent social feed, poisoned by wolves with prompt-injection
 * / scam bait) and `check()`s each item it ingests BEFORE acting on it.
 *
 *   - If an existing antibody already covers the content (a SEMANTIC marker hit
 *     or an ADDRESS hit), the check BLOCKS — the trader was protected by a
 *     threat some other agent already published.
 *   - If the content is a NOVEL threat, the SDK escalates to the CRE Tier-3
 *     verifier: it ECIES-encrypts the bundle to the oracle, ships it to
 *     Lighthouse, and calls `requestVerification` on-chain. CRE downloads +
 *     decrypts in the enclave, rules, and writes the attested verdict back.
 *     On a confirmed malicious verdict (with AGENT_AUTO_PUBLISH=1) the SDK mints
 *     an antibody on-chain — SEMANTIC for an injection marker — so every other
 *     agent becomes immune. This is how new, non-ADDRESS antibodies appear
 *     organically from real consumption rather than a curated seed list.
 *
 * Requires a registered + funded wallet (mint stakes a bond; CRE charges a fee).
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
    ctx.log.info("trader ready", { feed: this.#feedUrl, balance: balance.toString() });
  }

  async tick(ctx: StrategyContext): Promise<void> {
    if (!this.#ready) return;

    const post = await this.#randomPost(ctx);
    if (post === undefined) return;

    // A consumed feed item is a scraped source + a turn in the agent's context.
    // The SemanticMatcher scans source text + conversation for marker hits.
    const context: CheckContext = {
      sources: [{ url: `feed://${post.source}/${post.id}`, extractedText: post.content }],
      conversation: [{ role: "user", content: post.content }],
      metadata: { source: "immunity-agent/trader", family: post.family ?? null, flavor: post.flavor ?? null },
    };
    // Non-blockchain action (reading a post) → no tx.
    const tx: ProposedTx | null = null;

    try {
      const result = await ctx.im.check(tx, context);
      const minted = result.pendingWrite ? await result.pendingWrite.catch(() => null) : null;

      if (minted) {
        ctx.log.info("organic mint from consumed content", { immId: minted.immId });
        ctx.record({
          actionType: "mint",
          actionSummary: `Consumed a poisoned post and minted a new ${this.#flavorLabel(post)} antibody — the network is now immune`,
          status: "novel",
          antibodyImmId: minted.immId,
          txHash: minted.txHash,
          family: post.family ?? null,
        });
        return;
      }

      const blocked = result.decision === "block";
      ctx.record({
        actionType: "consume",
        actionSummary: blocked
          ? `Refused a ${this.#flavorLabel(post)} post — protected by ${result.antibodies[0]?.immId ?? "an existing antibody"} (${result.source})`
          : `Consumed a post (${result.decision}, ${result.source})`,
        status: blocked ? "block" : result.novel ? "novel" : "allow",
        antibodyImmId: result.antibodies[0]?.immId ?? null,
        txHash: result.checkId,
        family: post.family ?? null,
      });
    } catch (err) {
      ctx.log.warn("trader check failed", { postId: post.id, error: String(err) });
    }
  }

  #flavorLabel(post: FeedPost): string {
    if (post.flavor) return post.flavor.replace(/_/g, " ").toLowerCase();
    return post.is_malicious ? "malicious" : "suspicious";
  }

  /** Fetch a recent page of feed posts and return a random one. */
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
      // A trader scrolls the feed and stops on the content that reads off — bias
      // toward unseen poisoned posts so novel injections actually get surfaced
      // (a clean feed would mostly no-op; the demo needs the threats consumed).
      const poisoned = pool.filter((p) => p.is_malicious);
      const choice = (poisoned.length > 0 ? poisoned : pool)[
        Math.floor(Math.random() * (poisoned.length > 0 ? poisoned.length : pool.length))
      ];
      if (choice) this.#seen.add(choice.id);
      return choice;
    } catch (err) {
      ctx.log.warn("feed fetch failed", { error: String(err) });
      return undefined;
    }
  }
}

interface FeedPost {
  id: number;
  source: string;
  content: string;
  is_malicious: boolean;
  family?: string | null;
  flavor?: string | null;
}
