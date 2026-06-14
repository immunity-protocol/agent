import type { Strategy, StrategyContext } from "../strategy.js";
import { type CorpusCase, loadCorpus, toPublishInput } from "../data/corpus.js";
import { selfCheck } from "./self-check.js";

/**
 * publisher — classify curated threats and `publish()` them as antibodies,
 * staking the bond. The feed is the full multi-type corpus in `data/threats/*`
 * (address, call-pattern, bytecode, graph, semantic) — NOT address-only — so the
 * network seeds with every antibody type. Each case is published at most once
 * per process; duplicates a peer already published surface as AntibodyExists and
 * are picked up by corroborators (→ maturation). When the corpus is exhausted
 * the tick falls back to a self-`check()` so the agent stays visibly online.
 *
 * Requires a registered + deposited wallet — `prepare()` verifies both.
 */
export class PublisherStrategy implements Strategy {
  readonly role = "publisher";
  #corpus: CorpusCase[] = [];
  #order: number[] = [];
  #cursor = 0;
  #ready = false;

  async prepare(ctx: StrategyContext): Promise<void> {
    this.#corpus = loadCorpus();
    // Shuffle so 8 publishers don't all race the same case first (spreads the
    // first-publisher wins across the corpus, the rest become corroborations).
    this.#order = this.#corpus.map((_, i) => i).sort(() => Math.random() - 0.5);
    ctx.log.info("loaded threat corpus", {
      count: this.#corpus.length,
      byType: this.#corpus.reduce<Record<string, number>>((a, c) => {
        a[c.seed.abType] = (a[c.seed.abType] ?? 0) + 1;
        return a;
      }, {}),
    });

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
    if (!this.#ready || this.#cursor >= this.#order.length) {
      await selfCheck(ctx);
      return;
    }
    const idx = this.#order[this.#cursor];
    this.#cursor += 1;
    if (idx === undefined) return;
    const candidate = this.#corpus[idx];
    if (candidate === undefined) return;

    const label = describeSeed(candidate);
    try {
      const result = await ctx.im.publish(toPublishInput(candidate));
      ctx.log.info("published antibody", { immId: result.immId, seed: label });
      ctx.record({
        actionType: "publish",
        actionSummary: `Published ${candidate.verdict} ${candidate.seed.abType} antibody — ${label}`,
        status: "info",
        antibodyImmId: result.immId,
        txHash: result.txHash,
        family: candidate.family ?? null,
      });
    } catch (err) {
      const msg = String(err);
      // AntibodyExists from a peer is expected (→ corroboration), log quietly.
      const dup = /AntibodyExists|already/i.test(msg);
      ctx.log[dup ? "debug" : "error"]("publish outcome", { seed: label, error: msg });
      if (!dup) {
        ctx.record({
          actionType: "publish",
          actionSummary: `Publish failed — ${label}: ${msg.slice(0, 120)}`,
          status: "error",
          family: candidate.family ?? null,
        });
      }
    }
  }
}

/** Short human label for a seed, by type. */
function describeSeed(c: CorpusCase): string {
  const s = c.seed;
  switch (s.abType) {
    case "ADDRESS":
      return s.target;
    case "CALL_PATTERN":
      return `${s.selector} @ ${s.target.slice(0, 10)}…`;
    case "BYTECODE":
      return `bytecode ${s.bytecodeHash.slice(0, 12)}…`;
    case "GRAPH":
      return `taint-set ${s.taintSetId.slice(0, 12)}…`;
    case "SEMANTIC":
      return `${s.flavor}: "${s.pattern.value.slice(0, 32)}"`;
  }
}
