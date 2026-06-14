// Value-protected driver: a steady stream of REAL value-bearing blocks so the
// dashboard's "value protected" climbs organically during the demo. Each tick
// screens a transfer of $50–$20k to a random genesis drainer against that
// drainer's matured antibody — registry.check(antibodyId, USDC, amount, chain)
// → emits Matched(amount) → the indexer prices it into value_protected_usd.
//
// This is the proven direct-check path (same as scripts/scenario-checks.ts),
// looped. The fleet's SDK-side screen-action also blocks these, but the SDK
// currently settles policy matches with a zero antibodyId (no Matched event) —
// fixing that is a separate SDK change; this driver makes the metric real now.
//
// Run: DEPLOYER_PRIVATE_KEY=… BASE_SEPOLIA_RPC_URL=… npx tsx demo/value-driver.ts
import { JsonRpcProvider, Wallet, Contract, AbiCoder, keccak256 } from "ethers";

const coder = AbiCoder.defaultAbiCoder();
// Mirror the SDK/contract: matcher = keccak256(abi.encode(uint256 chainId, address target));
// keccakId = keccak256(abi.encode(uint8 abType, uint8 flavor, bytes32 matcher, address publisher)).
const hashAddressMatcher = (a: { chainId: number; target: string }): string =>
  keccak256(coder.encode(["uint256", "address"], [BigInt(a.chainId), a.target.toLowerCase()]));
const computeKeccakId = (_t: string, flavor: number, matcher: string, publisher: string): string =>
  keccak256(coder.encode(["uint8", "uint8", "bytes32", "address"], [0, flavor, matcher, publisher]));

const RPC = process.env.BASE_SEPOLIA_RPC_URL ?? "https://base-sepolia.g.alchemy.com/v2/C5BdobTzYALqWfs3wDc-I";
const REGISTRY = "0x7047F4D54A1F4C337BF940cBDee0E68D79B0323b";
const USDC = "0xe697EF7724453F239D8c0EB9295D87C344D9CE60";
const GENESIS_1 = "0x18628A448938aD61C3AAd97Eca1f99DE310684B4" as `0x${string}`;
const CHAIN = 84532;
const TICK_MS = Number(process.env.VALUE_DRIVER_TICK_MS ?? "9000");

const TARGETS = [
  "0x8589427373d6d84e98730d7795d8f6f8731fda16",
  "0x722122df12d4e14e13ac3b6895a86e84145b6967",
  "0xdd4c48c0b24039969fc16d1cdf626eab821d3384",
  "0xd90e2f925da726b50c4ed8d0fb90ad053324f31b",
  "0x910cbd523d972eb0a6f4cae4618ad62622b39dbf",
] as const;

const provider = new JsonRpcProvider(RPC, CHAIN);
const wallet = new Wallet(process.env.DEPLOYER_PRIVATE_KEY as string, provider);
const usdc = new Contract(USDC, ["function mint(address,uint256)", "function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"], wallet);
const reg = new Contract(REGISTRY, [
  "function deposit(uint256)",
  "function balances(address) view returns (uint256)",
  "function getEnforcementInputs(bytes32) view returns (uint8,uint16,uint256,uint8,uint64,uint64,bool)",
  "function check(bytes32 antibodyId, address tokenAddress, uint256 tokenAmount, uint256 originChainId) returns (bool)",
], wallet);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ensureBalance(): Promise<void> {
  const bal: bigint = await reg.balances(wallet.address);
  if (bal >= 1_000_000n) return; // > 1 USDC, plenty of fees
  const top = 10_000_000n; // 10 USDC
  await (await usdc.mint(wallet.address, top)).wait();
  if ((await usdc.allowance(wallet.address, REGISTRY)) < top) await (await usdc.approve(REGISTRY, top)).wait();
  await (await reg.deposit(top)).wait();
  console.log(`topped up operator balance +${Number(top) / 1e6} USDC`);
}

(async () => {
  console.log(`value-driver on ${REGISTRY} as ${wallet.address}, tick ${TICK_MS}ms`);
  let n = 0, total = 0;
  for (;;) {
    try {
      await ensureBalance();
      const target = TARGETS[Math.floor(Math.random() * TARGETS.length)] as `0x${string}`;
      const mh = hashAddressMatcher({ chainId: CHAIN, target });
      const antibodyId = computeKeccakId("ADDRESS", 0, mh, GENESIS_1);
      if (Number((await reg.getEnforcementInputs(antibodyId))[0]) !== 1) { await sleep(TICK_MS); continue; }
      const usdAmt = 50 + Math.floor(Math.random() * (20_000 - 50));
      const amount = BigInt(usdAmt) * 1_000_000n;
      const tx = await reg.check(antibodyId, USDC, amount, CHAIN);
      await tx.wait();
      n++; total += usdAmt;
      console.log(`#${n} blocked $${usdAmt.toLocaleString("en-US")} → ${target.slice(0, 10)}…  (session total $${total.toLocaleString("en-US")})`);
    } catch (e: any) {
      console.error("tick err", e?.shortMessage || e?.message || e);
    }
    await sleep(TICK_MS);
  }
})().catch((e) => { console.error("FATAL", e.shortMessage || e.message); process.exit(1); });
