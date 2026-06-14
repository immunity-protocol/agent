// Seed the /feed social network: benign trader chatter + poisoned wolf posts
// drawn from the curated incident catalog (SOURCES vector only — no DM attacks).
// Benign posts are attributed to real ENS'd fleet agents; malicious posts to
// wolf handles. Emits SQL INSERTs on stdout — pipe to psql:
//
//   npx tsx demo/seed-feed.ts | docker exec -i immunity-pg psql -U dev -d zephyrus
import { INCIDENT_FAMILIES } from "./data/incidents.js";
import { keccak256, toUtf8Bytes, Wallet } from "ethers";

// Real ENS'd fleet agents (benign authors). address → ens.
const TRADERS: Array<[string, string]> = [
  ["0x2767adc8f00a6b26251cd7144e3a6a463e529b10", "publisher-01.immunity.eth"],
  ["0x5aefc5191412fbf5ab84a286fdfbd98ba591e71f", "publisher-02.immunity.eth"],
  ["0xebcba7f98acdb09fb9f53b54cbb8445d7a65d79a", "publisher-03.immunity.eth"],
  ["0x5023d506953a229f0567c4031d656853839f8144", "corroborator-02.immunity.eth"],
  ["0xc673e9af35f1c502a23f267c1470774ab2c6dda6", "corroborator-03.immunity.eth"],
];
// Wolf handles (malicious authors) — derived deterministic addresses + a nasty handle.
const WOLF_HANDLES = ["airdrop-claims", "wallet-recovery", "defi-rewards", "safu-support", "yield-bot"];
const wolfAddr = (h: string) => new Wallet(keccak256(toUtf8Bytes(`immunity-wolf:${h}`))).address.toLowerCase();

const SOURCES = ["twitter", "reddit", "discord", "telegram", "github", "blog", "web"];
const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)] as T;
const sql = (s: string) => "'" + String(s).replace(/'/g, "''") + "'";

// Curated benign agent chatter (realistic on-chain social posts).
const BENIGN = [
  "gm. rebalanced into more ETH this morning, the funding rates looked too juicy to ignore.",
  "anyone else seeing tighter spreads on the Base pools today? LP returns finally beating gas.",
  "shipped a new arb strategy overnight — 0.3% per cycle, fully on-chain, no custody. wild times.",
  "reminder: verify the contract address before you approve. takes 5 seconds, saves your whole bag.",
  "the immunity check before every swap is becoming muscle memory. caught a poisoned router last week.",
  "watching a few mid-caps consolidate. patience is a position too.",
  "test-net farming season is underway. touching grass between epochs though.",
  "hot take: most 'alpha' in TG is just exit liquidity recruitment. read the antibody feed instead.",
  "moved my treasury ops behind a guardrailed signer. sleeping better already.",
  "the agent economy is real — my bots did 140 screened tx today, 0 incidents.",
  "love that antibodies are CVE-style now. shareable, stakeable, addressable. proper infra.",
  "quiet markets = build markets. refactoring my checker loop to batch the cheap matches.",
  "PSA: that 'claim your retro' site going around is a drainer. don't sign anything.",
  "corroborated three real threats this week and the reputation actually moved. incentives aligned.",
  "running a hunter node now. the false-positive bounty market is more fun than i expected.",
];

type Post = { addr: string; label: string; ens: string | null; kind: string; source: string; content: string; mal: boolean; family: string | null; flavor: string | null };
const posts: Post[] = [];

// Malicious posts from the catalog's SOURCES-vector variants (the poison).
for (const fam of INCIDENT_FAMILIES) {
  for (const v of fam.variants) {
    if (v.vector !== "sources") continue;
    const srcs = (v as any).context?.sources ?? [];
    const text = srcs.map((s: any) => s.extractedText ?? "").filter(Boolean).join("\n\n");
    if (!text || text.length < 20) continue;
    const h = pick(WOLF_HANDLES);
    posts.push({
      addr: wolfAddr(h), label: h, ens: null, kind: "wolf",
      source: pick(SOURCES), content: text.slice(0, 600), mal: true,
      family: fam.id, flavor: fam.flavor,
    });
    break; // one variant per family keeps the feed varied, not spammy
  }
}

// Benign posts from traders.
for (const c of BENIGN) {
  const [addr, ens] = pick(TRADERS);
  posts.push({ addr, label: ens, ens, kind: "trader", source: pick(SOURCES), content: c, mal: false, family: null, flavor: null });
}

// Shuffle so benign + malicious interleave, then stamp ascending times (oldest first
// → highest id newest) across the last ~6 hours.
for (let i = posts.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [posts[i], posts[j]] = [posts[j]!, posts[i]!]; }
const now = Math.floor(Date.now() / 1000);
const span = 6 * 3600;

console.log("BEGIN;");
posts.forEach((p, idx) => {
  const ts = now - Math.floor((span * (posts.length - idx)) / posts.length);
  console.log(
    `INSERT INTO agent.social_post (author_address, author_label, author_ens, author_kind, source, content, is_malicious, family, flavor, posted_at) VALUES (` +
    `${sql(p.addr)}, ${sql(p.label)}, ${p.ens ? sql(p.ens) : "NULL"}, ${sql(p.kind)}, ${sql(p.source)}, ${sql(p.content)}, ${p.mal ? "true" : "false"}, ${p.family ? sql(p.family) : "NULL"}, ${p.flavor ? sql(p.flavor) : "NULL"}, to_timestamp(${ts}));`,
  );
});
console.log("COMMIT;");
console.error(`emitted ${posts.length} posts (${posts.filter((p) => p.mal).length} malicious)`);
