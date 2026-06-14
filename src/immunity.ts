import { Immunity, BASE_SEPOLIA } from "@immunity-protocol/sdk";
import type { NetworkConfig } from "@immunity-protocol/sdk";
import { JsonRpcProvider, Wallet } from "ethers";
import type { AgentConfig } from "./config.js";

/**
 * Construct + start the SDK facade for this agent.
 *
 * The SDK accepts a private-key string and connects it against the network
 * preset's RPC. To honour `BASE_SEPOLIA_RPC_URL` (operators usually want their
 * own RPC, the public `sepolia.base.org` is rate-limited) we clone the
 * `BASE_SEPOLIA` preset with the RPC overridden and pass the full config object.
 *
 * `autoPublishConfirmedThreats` stays OFF by default: the bond-spending write is
 * driven explicitly by the role strategies, never as a silent side effect of a
 * `check()`.
 */
export async function startImmunity(cfg: AgentConfig): Promise<Immunity> {
  const network: NetworkConfig =
    cfg.rpcUrl === undefined ? BASE_SEPOLIA : { ...BASE_SEPOLIA, rpcUrl: cfg.rpcUrl };
  // The SDK's public config types `wallet` as a `Signer`; it accepts a raw key
  // at runtime, but we build a provider-connected `Wallet` so it's type-correct
  // and the signer is bound to the operator's chosen RPC.
  const wallet = new Wallet(cfg.walletKey, new JsonRpcProvider(network.rpcUrl));
  // Traders opt into auto-publish: a CRE-confirmed novel threat surfaced during
  // check() mints an antibody on-chain (SEMANTIC for injection markers). Gated by
  // AGENT_AUTO_PUBLISH so the bond-spending write stays explicit per role.
  const autoPublish = process.env.AGENT_AUTO_PUBLISH === "1";
  const im = new Immunity({ wallet, network, autoPublishConfirmedThreats: autoPublish });
  await im.start();
  return im;
}
