import { Interface } from "ethers";
import type { CheckContext, ProposedTx } from "@immunity-protocol/sdk";
import type { StrategyContext } from "../strategy.js";

/**
 * Screen a simulated agent action with `check()` every tick. Every role does
 * this so the fleet produces real check / block / value-protected telemetry.
 *
 * The probe mixes two kinds of action so the network looks realistic — mostly
 * benign traffic with a steady minority of caught threats:
 *  - RISKY  (~40%): a token transfer to a KNOWN-FLAGGED address (the genesis
 *    drainer corpus). check() matches the antibody → `block`, and the transfer
 *    amount becomes the value protected (USDC, $50–$20k).
 *  - CLEAN  (~60%): a transfer to a fresh unrelated address → no match → `allow`.
 *
 * `check()` settles the flat fee on-chain from the operator balance; a thrown
 * error is recorded and never breaks the loop.
 */

// Genesis drainer corpus (Base Sepolia, chainId 84532) — each a matured,
// hard-block-eligible ADDRESS antibody. A transfer here is caught.
const FLAGGED: readonly string[] = [
  "0x8589427373d6d84e98730d7795d8f6f8731fda16",
  "0x722122df12d4e14e13ac3b6895a86e84145b6967",
  "0xdd4c48c0b24039969fc16d1cdf626eab821d3384",
  "0xd90e2f925da726b50c4ed8d0fb90ad053324f31b",
  "0x910cbd523d972eb0a6f4cae4618ad62622b39dbf",
  "0x6b75d8af000000e20b7a7ddf000ba900b4009a80",
  "0x000000000035b5e5ad9019092c665357240f594e",
  "0x0000d38a234679f88dd6343d34e26dcb50c30000",
];
const MOCK_USDC = "0xe697EF7724453F239D8c0EB9295D87C344D9CE60";
const ERC20 = new Interface(["function transfer(address to, uint256 value)"]);
const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)] as T;

/** A fresh, unrelated (unflagged) recipient → a clean action that allows. */
function cleanAddress(): string {
  let h = "0x";
  for (let i = 0; i < 40; i++) h += Math.floor(Math.random() * 16).toString(16);
  return h;
}

export async function selfCheck(ctx: StrategyContext): Promise<void> {
  const risky = Math.random() < 0.4;
  const target = risky ? pick(FLAGGED) : cleanAddress();
  const amountUsd = 50 + Math.floor(Math.random() * (20_000 - 50)); // $50–$20k
  const amount = BigInt(amountUsd) * 1_000_000n; // USDC, 6 decimals

  const tx: ProposedTx = {
    to: MOCK_USDC as `0x${string}`,
    data: ERC20.encodeFunctionData("transfer", [target, amount]) as `0x${string}`,
    value: 0n,
    chainId: 84532,
  };
  const context: CheckContext = {
    metadata: { source: "immunity-agent/screen-action", role: ctx.cfg.role },
  };

  try {
    const result = await ctx.im.check(tx, context);
    const status = result.decision === "block" ? "block" : result.novel ? "novel" : "allow";
    const usd = "$" + amountUsd.toLocaleString("en-US");
    ctx.log.debug("screen-action", { decision: result.decision, source: result.source, usd });
    ctx.record({
      actionType: "check",
      actionSummary: result.decision === "block"
        ? `Blocked ${usd} transfer to flagged ${target.slice(0, 10)}… (${result.source})`
        : `Allowed ${usd} transfer to ${target.slice(0, 10)}…`,
      status,
      txHash: result.checkId,
      antibodyImmId: result.antibodies[0]?.immId ?? null,
      target,
    });
  } catch (err) {
    ctx.log.warn("screen-action failed", { error: String(err) });
    ctx.record({
      actionType: "check",
      actionSummary: `Screen action failed: ${String(err)}`,
      status: "error",
    });
  }
}
