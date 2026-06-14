// Fleet bootstrap — deployer-funded, MockUSDC-only (testnet). For each derived
// fleet member: top up Base Sepolia gas from the deployer, self-mint MockUSDC
// (the public-mint testnet token the whole demo trades), and — for publisher /
// corroborator roles, which must be registered to publish/corroborate — grant
// reputation (deployer is the Reputation owner), register the *.immunity.eth
// subname, and deposit the operator balance. Hunters need only gas (they
// challenge, which doesn't require registration). Idempotent: re-running skips
// anything already funded/registered.
//
// Run: DEPLOYER_PRIVATE_KEY=0x… FLEET_MNEMONIC="…" FLEET_MIX="publisher:20,hunter:13,corroborator:12" \
//      BASE_SEPOLIA_RPC_URL=… npx tsx fleet/bootstrap.ts
import { JsonRpcProvider, Wallet, NonceManager, Contract, parseEther, formatEther } from "ethers";
import { writeFileSync } from "node:fs";
import { Immunity, BASE_SEPOLIA } from "@immunity-protocol/sdk";
import { buildRoster, parseMix, DEFAULT_MNEMONIC, type FleetMember } from "./derive.js";

const RPC = process.env.BASE_SEPOLIA_RPC_URL ?? "https://base-sepolia.g.alchemy.com/v2/C5BdobTzYALqWfs3wDc-I";
const MNEMONIC = process.env.FLEET_MNEMONIC ?? DEFAULT_MNEMONIC;
const MIX = parseMix(process.env.FLEET_MIX ?? "publisher:3,hunter:3,corroborator:3");
const GAS_TOPUP = process.env.FLEET_GAS_TOPUP ?? "0.01";
const GAS_FLOOR = process.env.FLEET_GAS_FLOOR ?? "0.004";
const USDC_MINT = BigInt(process.env.FLEET_USDC_MINT ?? "100000000"); // 100 MockUSDC (6dp)
const USDC_FLOOR = BigInt(process.env.FLEET_USDC_FLOOR ?? "20000000"); // 20 MockUSDC
const DEPOSIT = BigInt(process.env.FLEET_DEPOSIT ?? "20000000"); // 20 MockUSDC into the operator balance
const REP_TARGET = BigInt(process.env.FLEET_REP ?? "100");
// The autoimmune adversary gets a small bond budget (it loses every bond) and a
// small starting reputation so the first slash visibly craters it to zero.
const AUTOIMMUNE_BUDGET = BigInt(process.env.FLEET_AUTOIMMUNE_BUDGET ?? "60000000"); // 60 MockUSDC
const AUTOIMMUNE_REP = BigInt(process.env.FLEET_AUTOIMMUNE_REP ?? "30");

const provider = new JsonRpcProvider(RPC, 84532);
const deployer = new NonceManager(new Wallet(process.env.DEPLOYER_PRIVATE_KEY as string, provider));

const usdc = new Contract(BASE_SEPOLIA.addresses.usdc, [
  "function mint(address,uint256)",
  "function balanceOf(address) view returns (uint256)",
], deployer);
const reputation = new Contract(BASE_SEPOLIA.addresses.reputation, [
  "function scoreOf(address) view returns (uint256)",
  "function grantGenesisReputation(address,uint256)",
  "function owner() view returns (address)",
], deployer);

async function topUpGas(addr: string): Promise<void> {
  const bal = await provider.getBalance(addr);
  if (bal >= parseEther(GAS_FLOOR)) return;
  const tx = await deployer.sendTransaction({ to: addr, value: parseEther(GAS_TOPUP) });
  await tx.wait();
}

async function mintUsdc(addr: string): Promise<void> {
  const bal: bigint = await usdc.balanceOf(addr);
  if (bal >= USDC_FLOOR) return;
  await (await usdc.mint(addr, USDC_MINT)).wait();
}

async function grantRep(addr: string, target: bigint): Promise<void> {
  const score: bigint = await reputation.scoreOf(addr);
  if (score >= target) return;
  await (await reputation.grantGenesisReputation(addr, target - score)).wait();
}

async function bootstrapMember(m: FleetMember): Promise<void> {
  // publisher/corroborator publish; autoimmune publishes (false) flags — all
  // three must be registered. Hunters only challenge (no registration).
  const isAdversary = m.role === "autoimmune";
  const needsRegistration = m.role === "publisher" || m.role === "corroborator" || isAdversary;
  await topUpGas(m.address);
  await mintUsdc(m.address);
  if (!needsRegistration) {
    console.log(`  ${m.label} (${m.role}) ${m.address} — gas+USDC only`);
    return;
  }
  // The adversary gets a small starting reputation (craters on first slash);
  // honest publishers get the genesis grant that lets them hard-block.
  await grantRep(m.address, isAdversary ? AUTOIMMUNE_REP : REP_TARGET);
  const im = new Immunity({ wallet: new Wallet(m.privateKey, provider), network: BASE_SEPOLIA });
  await im.start();
  if (!(await im.isRegistered())) {
    await im.registerPublisher(m.label); // mints <label>.immunity.eth
  }
  const deposit = isAdversary ? AUTOIMMUNE_BUDGET : DEPOSIT;
  const bal = await im.balanceOf();
  if (bal < deposit) await im.deposit(deposit - bal);
  console.log(`  ${m.label} (${m.role}) ${m.address} — registered + ${isAdversary ? "funded budget" : "deposited"}`);
}

(async () => {
  const roster = buildRoster(MNEMONIC, MIX);
  console.log(`bootstrapping ${roster.length} agents on the new Registry ${BASE_SEPOLIA.addresses.registry}`);
  console.log(`deployer ${await deployer.getAddress()} balance ${formatEther(await provider.getBalance(await deployer.getAddress()))} ETH`);

  const repOwner = (await reputation.owner()).toLowerCase();
  if (repOwner !== (await deployer.getAddress()).toLowerCase()) {
    throw new Error(`deployer is not the Reputation owner (${repOwner}) — cannot grant reputation`);
  }

  for (const m of roster) {
    try {
      await bootstrapMember(m);
    } catch (e: any) {
      console.error(`  ${m.label} FAILED: ${e?.shortMessage || e?.message || e}`);
    }
  }

  // Manifest for the supervisor (no private keys — it re-derives from the mnemonic).
  const manifest = roster.map(({ index, role, label, address }) => ({ index, role, label, address }));
  writeFileSync("fleet/fleet.json", JSON.stringify({ mix: MIX, members: manifest }, null, 2));
  console.log(`\nwrote fleet/fleet.json (${manifest.length} members)`);
})().catch((e) => { console.error("ERR", e.shortMessage || e.message); process.exit(1); });
