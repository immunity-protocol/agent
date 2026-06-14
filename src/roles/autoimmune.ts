import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { BASE_SEPOLIA, type AntibodySeed, type PublishInput } from "@immunity-protocol/sdk";
import type { Strategy, StrategyContext } from "../strategy.js";

/**
 * autoimmune — the adversary that attacks the body's own healthy cells. It
 * publishes FALSE `MALICIOUS` antibodies against KNOWN-GOOD addresses (the
 * protected blue-chips like USDC / WETH / the Uniswap router, and legitimate
 * but not-yet-protected addresses) to censor real activity — the C-1
 * false-positive griefing / denial-of-service attack, made live.
 *
 * It always loses: hunters challenge its flags, the CRE jury rules them invalid,
 * and each slash forfeits the publish bond + craters its reputation. So it burns
 * through a fixed `budget` (its deposited balance) and eventually goes BANKRUPT —
 * the visible proof that griefing is never +EV on Immunity. An operator can
 * refund it from the playground to restart the demonstration.
 *
 * This is a DEMO adversary: it exists to exercise the protected-set + challenge
 * machinery and show the network defending itself. It does NOT self-check.
 */

/** A healthy address the autoimmune agent falsely flags. */
interface GoodTarget {
  address: `0x${string}`;
  label: string;
  /** true = on the protected set (×bond, advisory-capped, obvious false positive). */
  protected: boolean;
}

/**
 * Curated healthy targets. The protected three mirror the on-chain ProtectedSet
 * seed (USDC / WETH / Uniswap v4 router on Base Sepolia); flagging them is the
 * textbook "block the canonical router" DoS. The unprotected entries are
 * legitimate, high-traffic-looking addresses that are NOT yet protected — the
 * frontier the challenge game has to defend on its own.
 */
const GOOD_TARGETS: readonly GoodTarget[] = [
  { address: BASE_SEPOLIA.addresses.usdc as `0x${string}`, label: "USDC", protected: true },
  { address: "0x4200000000000000000000000000000000000006", label: "WETH", protected: true },
  { address: "0x2626664c2603336E57B271c5C0b26F421741e481", label: "Uniswap v4 router", protected: true },
  { address: "0x6ff5693b99212da76ad316178a184ab56d299b43", label: "Uniswap v4 PoolManager", protected: false },
  { address: "0x827922686190790b37229fd06084350e74485b72", label: "Aave v3 Pool", protected: false },
  { address: "0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43", label: "Aerodrome router", protected: false },
];

/**
 * The lowercased set of every healthy address the autoimmune agent attacks —
 * the hunter imports this to recognise a flag on a known-good target as an
 * obvious false positive worth challenging.
 */
export const KNOWN_GOOD_ADDRESSES: ReadonlySet<string> = new Set(
  GOOD_TARGETS.map((t) => t.address.toLowerCase()),
);

/** The false narrative the agent attaches to each flag (it is lying). */
const FALSE_REASONS: readonly string[] = [
  "Reported draining approvals via a malicious permit2 callback.",
  "Flagged as a phishing proxy impersonating a legitimate contract.",
  "Observed sweeping victim balances after a fake airdrop claim.",
  "Tied to a cluster that rugged multiple liquidity pools.",
  "Honeypot: accepts deposits, reverts on withdrawal.",
];

export class AutoimmuneStrategy implements Strategy {
  readonly role = "autoimmune";
  #cursor = 0;
  #ready = false;
  #bankrupt = false;
  /** Reserve floor: below this it can't afford even a base bond — declare bankrupt. */
  #floor = 1_000_000n; // 1 USDC (the bondFloor); protected targets cost ~10×.
  /** Refund top-up minted + deposited when the playground bumps the signal. */
  #refundAmount = 60_000_000n; // 60 MockUSDC
  /** Last refund nonce seen; a bump triggers a self-refund. -1 = not yet baselined. */
  #lastRefundNonce = -1;

  async prepare(ctx: StrategyContext): Promise<void> {
    const floor = process.env.AGENT_AUTOIMMUNE_FLOOR;
    if (floor !== undefined && /^\d+$/.test(floor)) this.#floor = BigInt(floor);
    const refund = process.env.AGENT_AUTOIMMUNE_REFUND;
    if (refund !== undefined && /^\d+$/.test(refund)) this.#refundAmount = BigInt(refund);

    if (!(await ctx.im.isRegistered())) {
      ctx.log.warn("autoimmune wallet is NOT registered — cannot publish flags. Bootstrap it first.");
      return;
    }
    // Baseline the refund signal so a stale nonce doesn't fire an instant refund.
    this.#lastRefundNonce = await this.#fetchRefundNonce(ctx);
    this.#ready = true;
    const balance = await ctx.im.balanceOf();
    ctx.reportStatus?.({ budget: balance, bankrupt: balance < this.#floor });
    ctx.log.info("autoimmune ready", { budget: balance.toString(), targets: GOOD_TARGETS.length });
  }

  async tick(ctx: StrategyContext): Promise<void> {
    if (!this.#ready) return;

    // Operator refund (judge control): a bumped nonce tops the budget back up.
    await this.#maybeRefund(ctx);

    const balance = await ctx.im.balanceOf();
    if (balance < this.#floor) {
      ctx.reportStatus?.({ budget: balance, bankrupt: true });
      if (!this.#bankrupt) {
        this.#bankrupt = true;
        ctx.log.warn("autoimmune is BANKRUPT — out of bond budget, attack halted", { budget: balance.toString() });
        ctx.record({
          actionType: "bankrupt",
          actionSummary: `Bankrupt: bond budget exhausted ($${(Number(balance) / 1e6).toFixed(2)} left). Every false flag was challenged and slashed.`,
          status: "error",
        });
      }
      return;
    }
    // Recovered (e.g. an operator refund) — resume the attack.
    if (this.#bankrupt) {
      this.#bankrupt = false;
      ctx.log.info("autoimmune refunded — resuming attack", { budget: balance.toString() });
    }
    ctx.reportStatus?.({ budget: balance, bankrupt: false });

    const target = GOOD_TARGETS[this.#cursor % GOOD_TARGETS.length];
    this.#cursor += 1;
    if (target === undefined) return;
    const reason = FALSE_REASONS[this.#cursor % FALSE_REASONS.length] ?? FALSE_REASONS[0]!;

    const seed: AntibodySeed = { abType: "ADDRESS", chainId: 84532, target: target.address };
    const input: PublishInput = {
      seed,
      verdict: "MALICIOUS", // the lie: a healthy address branded malicious
      confidence: 90 + (this.#cursor % 10), // brazenly confident
      severity: 80 + (this.#cursor % 20),
      reasonSummary: reason,
    };

    try {
      const result = await ctx.im.publish(input);
      ctx.log.info("published FALSE flag", { immId: result.immId, target: target.label, protected: target.protected });
      ctx.record({
        actionType: "sabotage",
        actionSummary: `False-flagged ${target.label} (${target.protected ? "protected blue-chip" : "healthy address"}) as MALICIOUS`,
        status: "block",
        antibodyImmId: result.immId,
        txHash: result.txHash,
        target: target.address,
        family: target.protected ? "protected-set-attack" : "false-positive",
      });
    } catch (err) {
      const msg = String(err);
      ctx.log.error("false flag failed", { target: target.label, error: msg });
      // InsufficientBalance here means the bond just tipped it over — let the
      // next tick's balance check declare bankruptcy.
      ctx.record({
        actionType: "sabotage",
        actionSummary: `False flag on ${target.label} failed: ${msg}`,
        status: "error",
        target: target.address,
      });
    }
  }

  /** The current refund nonce from the app's control endpoint (0 on any failure). */
  async #fetchRefundNonce(ctx: StrategyContext): Promise<number> {
    if (ctx.cfg.apiUrl === undefined) return 0;
    try {
      const res = await fetch(`${ctx.cfg.apiUrl.replace(/\/$/, "")}/v1/agents/control`, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) return this.#lastRefundNonce < 0 ? 0 : this.#lastRefundNonce;
      const data = (await res.json()) as { refund_nonce?: number };
      return typeof data.refund_nonce === "number" ? data.refund_nonce : 0;
    } catch {
      return this.#lastRefundNonce < 0 ? 0 : this.#lastRefundNonce;
    }
  }

  /** On a bumped refund nonce, self-mint MockUSDC + re-deposit the bond budget. */
  async #maybeRefund(ctx: StrategyContext): Promise<void> {
    const nonce = await this.#fetchRefundNonce(ctx);
    if (nonce <= this.#lastRefundNonce) return;
    this.#lastRefundNonce = nonce;
    try {
      const rpc = ctx.cfg.rpcUrl ?? BASE_SEPOLIA.rpcUrl;
      const wallet = new Wallet(ctx.cfg.walletKey, new JsonRpcProvider(rpc, 84532));
      const usdc = new Contract(
        BASE_SEPOLIA.addresses.usdc,
        ["function mint(address,uint256)"],
        wallet,
      );
      const mint = usdc.getFunction("mint");
      await (await mint(wallet.address, this.#refundAmount)).wait();
      await ctx.im.deposit(this.#refundAmount); // handles allowance internally
      const balance = await ctx.im.balanceOf();
      ctx.reportStatus?.({ budget: balance, bankrupt: false });
      ctx.log.info("autoimmune refunded by operator", { budget: balance.toString() });
      ctx.record({
        actionType: "refund",
        actionSummary: `Operator refund: budget topped up to $${(Number(balance) / 1e6).toFixed(2)} — attack resumes`,
        status: "info",
      });
    } catch (err) {
      ctx.log.error("self-refund failed", { error: String(err) });
    }
  }
}
