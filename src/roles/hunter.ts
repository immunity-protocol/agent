import type { Strategy, StrategyContext } from "../strategy.js";
import { KNOWN_GOOD_ADDRESSES } from "./autoimmune.js";
import { selfCheck } from "./self-check.js";

/**
 * One antibody row from the app's public `GET /antibodies` feed. Only the
 * fields the hunter's heuristic reads are typed; the endpoint returns more.
 */
interface AntibodyRow {
  keccak_id: string;
  imm_id: string;
  type: string;
  verdict: string;
  status: string;
  confidence: number;
  severity: number;
  is_seeded?: number;
  corroboration_count?: number;
  /** 1 = the target is on the protected set (flagging it is an obvious FP). */
  prominence_tier?: number;
  /** The matcher seed; `target` is the flagged address. */
  primary_matcher?: { target?: string } | null;
}

/**
 * hunter (challenger) — watch recently-published antibodies and `challenge()`
 * the ones it judges to be likely FALSE POSITIVES. Accuracy is its edge: a
 * lost challenge slashes its bond, so the heuristic is deliberately
 * CONSERVATIVE and only fires when confident.
 *
 * Heuristic (simple + documented — operators are expected to replace it):
 *   - Only consider `probation` (advisory) antibodies. ACTIVE/matured ones are
 *     corroborated/seeded and challenging them is a losing bet.
 *   - Never challenge `is_seeded` (genesis) antibodies.
 *   - Flag as a likely false positive when the publisher's own stated
 *     `confidence` is LOW (< AGENT_HUNTER_CONFIDENCE_FLOOR, default 40): a
 *     low-confidence advisory with no corroboration is the cheapest, safest
 *     thing to contest.
 *   - Challenge each antibody at most once per process.
 *
 * Reading the feed needs `IMMUNITY_API_URL`; without it the hunter only runs
 * self-checks (and logs that challenging is disabled).
 */
export class HunterStrategy implements Strategy {
  readonly role = "hunter";
  readonly #seen = new Set<string>();
  #confidenceFloor = 40;
  #ready = false;

  async prepare(ctx: StrategyContext): Promise<void> {
    const floor = Number(process.env.AGENT_HUNTER_CONFIDENCE_FLOOR);
    if (Number.isInteger(floor) && floor >= 0 && floor <= 100) this.#confidenceFloor = floor;

    if (ctx.cfg.apiUrl === undefined) {
      ctx.log.warn(
        "IMMUNITY_API_URL is unset — the hunter cannot read the antibody feed, so challenging is disabled (self-checks only).",
      );
      return;
    }
    this.#ready = true;
    ctx.log.info("hunter ready", { confidenceFloor: this.#confidenceFloor });
  }

  async tick(ctx: StrategyContext): Promise<void> {
    await selfCheck(ctx);
    if (!this.#ready || ctx.cfg.apiUrl === undefined) return;

    const rows = await this.#fetchRecent(ctx);
    // Pick a RANDOM unseen false positive rather than always the first — so a
    // fleet of hunters spreads across the open false flags instead of all piling
    // onto the newest one (only the first challenger wins; the rest revert).
    const candidates = rows.filter((r) => this.#isLikelyFalsePositive(r) && !this.#seen.has(r.keccak_id));
    if (candidates.length === 0) return;
    const target = candidates[Math.floor(Math.random() * candidates.length)]!;
    this.#seen.add(target.keccak_id);

    try {
      const result = await ctx.im.challenge(target.keccak_id);
      ctx.log.info("challenged antibody", { immId: target.imm_id, bond: result.bond.toString() });
      ctx.record({
        actionType: "challenge",
        actionSummary: `Challenged ${target.imm_id} — ${this.#challengeReason(target)}`,
        status: "info",
        antibodyImmId: target.imm_id,
        txHash: result.txHash,
      });
    } catch (err) {
      ctx.log.error("challenge failed", { immId: target.imm_id, error: String(err) });
      ctx.record({
        actionType: "challenge",
        actionSummary: `Challenge failed for ${target.imm_id}: ${String(err)}`,
        status: "error",
        antibodyImmId: target.imm_id,
      });
    }
  }

  #challengeReason(r: AntibodyRow): string {
    if ((r.prominence_tier ?? 0) >= 1) return "flagged a PROTECTED blue-chip address";
    const target = r.primary_matcher?.target?.toLowerCase();
    if (target !== undefined && KNOWN_GOOD_ADDRESSES.has(target)) return "flagged a known-good address";
    return `low publisher confidence (${r.confidence})`;
  }

  #isLikelyFalsePositive(r: AntibodyRow): boolean {
    if (r.status !== "probation") return false;
    if (r.is_seeded === 1) return false;
    // A flag on a protected blue-chip (USDC / WETH / router) or a curated
    // known-good address is a false positive NO MATTER how many naive
    // corroborators piled on — challenge it regardless of corroboration/confidence.
    if ((r.prominence_tier ?? 0) >= 1) return true;
    const target = r.primary_matcher?.target?.toLowerCase();
    if (target !== undefined && KNOWN_GOOD_ADDRESSES.has(target)) return true;
    // Otherwise the cheapest safe contest: a low-confidence, uncorroborated advisory.
    if ((r.corroboration_count ?? 0) > 0) return false;
    return r.confidence < this.#confidenceFloor;
  }

  async #fetchRecent(ctx: StrategyContext): Promise<AntibodyRow[]> {
    const base = ctx.cfg.apiUrl?.replace(/\/$/, "");
    const url = `${base}/v1/antibodies?status=probation&limit=30`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        ctx.log.warn("antibody feed fetch rejected", { status: res.status });
        return [];
      }
      const body = (await res.json()) as { items?: AntibodyRow[] };
      return Array.isArray(body.items) ? body.items : [];
    } catch (err) {
      ctx.log.warn("antibody feed fetch failed", { error: String(err) });
      return [];
    }
  }
}
