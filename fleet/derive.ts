// Deterministic fleet wallet derivation. All agent wallets descend from one
// BIP-39 mnemonic (FLEET_MNEMONIC) at m/44'/60'/0'/0/i, so the bootstrap (which
// funds + registers) and the supervisor (which launches) agree on addresses
// without ever passing private keys between them.
import { Mnemonic, HDNodeWallet } from "ethers";
import type { Role } from "../src/config.js";

export interface FleetMember {
  index: number;
  role: Role;
  label: string;
  address: string;
  privateKey: string;
}

/** A throwaway demo mnemonic; override with FLEET_MNEMONIC for a real run. */
export const DEFAULT_MNEMONIC =
  "test test test test test test test test test test test junk";

/**
 * Build the fleet roster. `mix` is a role→count map; members are laid out
 * role-by-role at successive HD indices so a member's identity is stable across
 * runs (index N is always the same wallet + role for a given mnemonic + mix).
 */
export function buildRoster(mnemonic: string, mix: Record<Role, number>): FleetMember[] {
  const phrase = Mnemonic.fromPhrase(mnemonic.trim());
  // Cosmetic label/ENS-subname numbering offset (does NOT change the HD index).
  // Bump it when re-bootstrapping a fresh fleet so labels don't collide with the
  // *.immunity.eth subnames already minted by a previous fleet.
  const labelOffset = Number(process.env.FLEET_LABEL_OFFSET ?? "0") || 0;
  const members: FleetMember[] = [];
  let i = 0;
  for (const role of Object.keys(mix) as Role[]) {
    for (let n = 0; n < mix[role]; n++) {
      const w = HDNodeWallet.fromMnemonic(phrase, `m/44'/60'/0'/0/${i}`);
      members.push({
        index: i,
        role,
        label: `${role}-${String(labelOffset + n + 1).padStart(2, "0")}`,
        address: w.address.toLowerCase(),
        privateKey: w.privateKey,
      });
      i++;
    }
  }
  return members;
}

/** Parse "publisher:20,hunter:13,corroborator:12,autoimmune:2" → {publisher:20,...}. */
export function parseMix(spec: string): Record<Role, number> {
  const mix: Record<Role, number> = { publisher: 0, hunter: 0, corroborator: 0, autoimmune: 0 };
  for (const part of spec.split(",")) {
    const [role, n] = part.split(":").map((s) => s.trim());
    if (role in mix) mix[role as Role] = Number(n) || 0;
  }
  return mix;
}
