import { Immunity, BASE_SEPOLIA } from "@immunity-protocol/sdk";
import type { NetworkConfig } from "@immunity-protocol/sdk";
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
  const im = new Immunity({
    wallet: cfg.walletKey,
    network,
  });
  await im.start();
  return im;
}
