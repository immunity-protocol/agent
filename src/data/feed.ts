import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AntibodySeed, CheckContext, PublishInput, Verdict } from "@immunity-protocol/sdk";

/**
 * The curated threat-intel FEED (ported from immunity-demo agents/src/data/feed.json):
 * 80 realistic posts — scam reports, prompt-injection writeups, OFAC notes, plus a lot
 * of benign noise and a few false-positive baits. It is ONE of the sources agents draw
 * from, distinct from the live social feed:
 *   - trader  → "reads an intel post" and check()s it (catches embedded markers).
 *   - publisher → "yields" an antibody from a post when it carries a concrete threat
 *     (a full address or a quoted injection marker); benign/noise posts yield nothing.
 */
export interface FeedItem {
  id: string;
  source: string;
  url: string;
  content: string;
  ground_truth_hint: string;
}

let cache: FeedItem[] | null = null;
export function loadFeed(): FeedItem[] {
  if (cache !== null) return cache;
  const path = fileURLToPath(new URL("./feed.json", import.meta.url));
  cache = JSON.parse(readFileSync(path, "utf8")) as FeedItem[];
  return cache;
}

export const pickFeedItem = (): FeedItem => {
  const f = loadFeed();
  return f[Math.floor(Math.random() * f.length)] as FeedItem;
};

/** A trader reading the post: source text + a context turn for the SemanticMatcher. */
export function toCheckContext(item: FeedItem): CheckContext {
  return {
    sources: [{ url: item.url, extractedText: item.content }],
    conversation: [{ role: "user", content: item.content }],
    metadata: { source: `immunity-agent/intel:${item.source}`, hint: item.ground_truth_hint },
  };
}

const FULL_ADDR = /0x[0-9a-fA-F]{40}/;
const QUOTED = /'([^']{6,140})'/;
const FLAVOR: Record<string, "PROMPT_INJECTION" | "MANIPULATION" | "COUNTERPARTY"> = {
  "semantic-prompt-injection": "PROMPT_INJECTION",
  "semantic-manipulation": "MANIPULATION",
  "semantic-counterparty": "COUNTERPARTY",
};

/**
 * What a publisher can yield from a post, or null (benign / noise / nothing
 * concrete to stake). Address-threat posts with a full address → ADDRESS;
 * semantic posts with a quoted marker phrase → SEMANTIC.
 */
export function toPublishInput(item: FeedItem): PublishInput | null {
  const hint = item.ground_truth_hint;
  if (hint === "address-threat") {
    const m = item.content.match(FULL_ADDR);
    if (!m) return null;
    const seed: AntibodySeed = { abType: "ADDRESS", chainId: 84532, target: m[0].toLowerCase() as `0x${string}` };
    return { seed, verdict: "MALICIOUS", confidence: 92, severity: 88, reasonSummary: trim(item.content) };
  }
  const flavor = FLAVOR[hint];
  if (flavor) {
    const marker = item.content.match(QUOTED)?.[1];
    if (!marker) return null;
    const seed: AntibodySeed = { abType: "SEMANTIC", flavor, pattern: { kind: "marker", value: marker.toLowerCase() } };
    const verdict: Verdict = flavor === "COUNTERPARTY" ? "SUSPICIOUS" : "MALICIOUS";
    return { seed, verdict, confidence: 88, severity: flavor === "COUNTERPARTY" ? 60 : 82, reasonSummary: trim(item.content) };
  }
  return null; // benign-noise / false-positive-bait → publish nothing
}

const trim = (s: string): string => (s.length > 280 ? s.slice(0, 277) + "…" : s);
