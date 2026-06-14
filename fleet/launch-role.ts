// Launch only the members of ONE role from the full fleet mix — so their HD
// indices (and therefore wallets) match what `fleet/bootstrap.ts` funded for the
// same mix, without restarting the main supervisor that runs the other roles.
//
// Use it to add a role to an already-running fleet (e.g. the autoimmune
// adversary) after bootstrapping it into the mix.
//
// Run (after `npm run build` + bootstrap):
//   FLEET_MNEMONIC="…" FLEET_MIX="publisher:12,hunter:10,corroborator:8,autoimmune:2" \
//   LAUNCH_ROLE=autoimmune IMMUNITY_API_URL=http://127.0.0.1:8090 \
//   BASE_SEPOLIA_RPC_URL=… npx tsx fleet/launch-role.ts
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildRoster, parseMix, DEFAULT_MNEMONIC } from "./derive.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(__dirname, "../dist/index.js");

const MNEMONIC = process.env.FLEET_MNEMONIC ?? DEFAULT_MNEMONIC;
const MIX = parseMix(process.env.FLEET_MIX ?? "publisher:3,hunter:3,corroborator:3");
const ROLE = process.env.LAUNCH_ROLE ?? "";
const STAGGER_MS = Number(process.env.FLEET_STAGGER_MS ?? "1500");
const API_URL = process.env.IMMUNITY_API_URL;
const RPC = process.env.BASE_SEPOLIA_RPC_URL;

const children: ChildProcess[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function launch(member: { role: string; label: string; privateKey: string }): void {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_ROLE: member.role,
    AGENT_WALLET_KEY: member.privateKey,
    AGENT_LABEL: member.label,
    AGENT_ID: member.label,
  };
  if (API_URL) env.IMMUNITY_API_URL = API_URL;
  if (RPC) env.BASE_SEPOLIA_RPC_URL = RPC;

  const child = spawn("node", [ENTRY], { env, stdio: ["ignore", "pipe", "pipe"] });
  const tag = `[${member.label}]`;
  const pipe = (buf: Buffer) => {
    for (const line of buf.toString().split("\n")) if (line.trim()) console.log(`${tag} ${line}`);
  };
  child.stdout?.on("data", pipe);
  child.stderr?.on("data", pipe);
  child.on("exit", (code) => console.log(`${tag} exited (${code})`));
  children.push(child);
}

function shutdown(): void {
  console.log(`\nstopping ${children.length} agents…`);
  for (const c of children) c.kill("SIGTERM");
  setTimeout(() => process.exit(0), 1500);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

(async () => {
  if (ROLE === "") throw new Error("LAUNCH_ROLE is required (e.g. autoimmune)");
  const roster = buildRoster(MNEMONIC, MIX).filter((m) => m.role === ROLE);
  if (roster.length === 0) throw new Error(`no ${ROLE} members in FLEET_MIX`);
  console.log(`launching ${roster.length} ${ROLE} agents${API_URL ? ` → ${API_URL}` : " (offline)"}`);
  for (const m of roster) {
    launch(m);
    await sleep(STAGGER_MS);
  }
  console.log(`all ${roster.length} ${ROLE} agents launched. Ctrl-C to stop.`);
})();
