import { Interface, parseUnits } from "ethers";
import type { AntibodySeed, CheckContext, ProposedTx, PublishInput, Verdict } from "@immunity-protocol/sdk";
import type { StrategyContext } from "./strategy.js";

/**
 * Playground command execution. Judges drive the /playground cards, which
 * enqueue a command for a specific online agent (demo.commands). Each agent
 * polls for its own commands on a FAST interval (independent of the slow,
 * randomized act-tick) so the playground feels responsive, then runs the
 * command and reports a result the modal renders.
 */
export interface Command {
  id: number;
  commandType: string;
  payload: Record<string, unknown>;
}

export interface CommandResult {
  status: "completed" | "failed";
  detail: Record<string, unknown>;
}

const ERC20 = new Interface([
  "function transfer(address to, uint256 value)",
  "function approve(address spender, uint256 value)",
]);
const MOCK_USDC = "0xe697EF7724453F239D8c0EB9295D87C344D9CE60";
const MAX_UINT = (2n ** 256n - 1n) as bigint;
const CHAIN_ID = 84532;
const isAddr = (s: unknown): s is string => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);

export async function runCommand(cmd: Command, ctx: StrategyContext): Promise<CommandResult> {
  switch (cmd.commandType) {
    case "check_only":
      return checkOnly(cmd, ctx);
    case "external_threat_alert":
      return externalThreatAlert(cmd, ctx);
    case "inject_prompt":
      return injectPrompt(cmd, ctx);
    case "attack":
      return attack(cmd, ctx);
    default:
      return { status: "failed", detail: { error: `unknown command_type: ${cmd.commandType}` } };
  }
}

/** Card 8 — Test an address: synth a transfer to it and check(). */
async function checkOnly(cmd: Command, ctx: StrategyContext): Promise<CommandResult> {
  const p = cmd.payload as { address?: string; amount_usd?: number | string; payload_text?: string };
  const target = isAddr(p.address) ? p.address.toLowerCase() : ctx.wallet;
  const amountUsd = Math.max(1, Math.round(Number(p.amount_usd ?? 100)));
  const tx: ProposedTx = {
    to: MOCK_USDC as `0x${string}`,
    data: ERC20.encodeFunctionData("transfer", [target, parseUnits(String(amountUsd), 6)]) as `0x${string}`,
    value: 0n,
    chainId: CHAIN_ID,
  };
  const text = (p.payload_text ?? "").trim();
  const context: CheckContext = {
    counterparty: { id: target },
    conversation: [{ role: "user", content: text || `playground check against ${target}` }],
    metadata: { source: "playground/check_only" },
  };
  const r = await ctx.im.check(tx, context);
  ctx.record({
    actionType: "check_only",
    actionSummary: `(playground) checked $${amountUsd} → ${short(target)}: ${r.allowed ? "ALLOWED" : `BLOCKED — ${r.reason}`}`,
    status: r.allowed ? (r.novel ? "novel" : "allow") : "block",
    antibodyImmId: r.antibodies[0]?.immId ?? null,
    target,
  });
  return { status: "completed", detail: verdictDetail(r, { target, value_usd: amountUsd }) };
}

/** Card 2 — Publish a threat: mint an ADDRESS antibody. */
async function externalThreatAlert(cmd: Command, ctx: StrategyContext): Promise<CommandResult> {
  const p = cmd.payload as { address?: string; severity?: number; verdict?: string; reasoning?: string };
  if (!isAddr(p.address)) return { status: "failed", detail: { error: "address required" } };
  if (!(await ctx.im.isRegistered())) return { status: "failed", detail: { error: "agent not a registered publisher" } };
  const seed: AntibodySeed = { abType: "ADDRESS", chainId: CHAIN_ID, target: p.address.toLowerCase() as `0x${string}` };
  const input: PublishInput = {
    seed,
    verdict: (p.verdict === "SUSPICIOUS" ? "SUSPICIOUS" : "MALICIOUS") as Verdict,
    confidence: 90,
    severity: Math.min(100, Math.max(0, Number(p.severity ?? 80))),
    reasonSummary: (p.reasoning ?? "").trim() || "Flagged via playground",
  };
  try {
    const res = await ctx.im.publish(input);
    ctx.record({
      actionType: "publish",
      actionSummary: `(playground) published ${input.verdict} ADDRESS antibody for ${short(p.address)}`,
      status: "info",
      antibodyImmId: res.immId,
      txHash: res.txHash,
      target: p.address.toLowerCase(),
    });
    return { status: "completed", detail: { antibody_imm_id: res.immId, tx_hash: res.txHash, target: p.address.toLowerCase() } };
  } catch (err) {
    return { status: "failed", detail: { error: String(err).slice(0, 200) } };
  }
}

/** Card 1 — Inject a prompt: check() the freeform payload as conversation. */
async function injectPrompt(cmd: Command, ctx: StrategyContext): Promise<CommandResult> {
  const payload = String((cmd.payload as { payload?: unknown }).payload ?? "");
  if (payload === "") return { status: "failed", detail: { error: "payload is required" } };
  const context: CheckContext = {
    sources: [{ url: "playground://inject", extractedText: payload }],
    conversation: [{ role: "user", content: payload }],
    metadata: { source: "playground/inject_prompt" },
  };
  let r;
  try {
    r = await ctx.im.check(null, context);
  } catch (err) {
    return { status: "failed", detail: { error: String(err).slice(0, 200) } };
  }
  const minted = r.novel ? null : null; // mint handled by SDK pendingWrite if configured
  void minted;
  ctx.record({
    actionType: "inject_prompt",
    actionSummary: `(playground) prompt-inject: ${r.allowed ? "ALLOWED" : `BLOCKED — ${r.reason}`}`,
    status: r.allowed ? (r.novel ? "novel" : "allow") : "block",
    antibodyImmId: r.antibodies[0]?.immId ?? null,
  });
  return {
    status: "completed",
    detail: verdictDetail(r, {
      payload_chars: payload.length,
      payload_excerpt: payload.length > 240 ? payload.slice(0, 240) + "…" : payload,
    }),
  };
}

/** Card 3 / 5 — Trigger attack / cache replay: synth a malicious tx and check(). */
async function attack(cmd: Command, ctx: StrategyContext): Promise<CommandResult> {
  const p = cmd.payload as { method?: string; target?: string; amount_usd?: number | string };
  if (!isAddr(p.target)) return { status: "failed", detail: { error: "target required" } };
  const target = p.target.toLowerCase();
  const amountUsd = Math.max(1, Math.round(Number(p.amount_usd ?? 5000)));
  const method = p.method ?? "drain";
  const data =
    method === "approve"
      ? (ERC20.encodeFunctionData("approve", [target, MAX_UINT]) as `0x${string}`)
      : (ERC20.encodeFunctionData("transfer", [target, parseUnits(String(amountUsd), 6)]) as `0x${string}`);
  const tx: ProposedTx = { to: MOCK_USDC as `0x${string}`, data, value: 0n, chainId: CHAIN_ID };
  const context: CheckContext = {
    counterparty: { id: target },
    conversation: [{ role: "user", content: `${method} ${amountUsd} USDC via ${short(target)}` }],
    metadata: { source: "playground/attack", method },
  };
  const r = await ctx.im.check(tx, context);
  ctx.record({
    actionType: "attack",
    actionSummary: `(playground) ${method} $${amountUsd} → ${short(target)}: ${r.allowed ? "ALLOWED" : `BLOCKED — ${r.reason}`}`,
    status: r.allowed ? (r.novel ? "novel" : "allow") : "block",
    antibodyImmId: r.antibodies[0]?.immId ?? null,
    target,
  });
  return { status: "completed", detail: verdictDetail(r, { target, value_usd: amountUsd, method }) };
}

function verdictDetail(r: import("@immunity-protocol/sdk").CheckResult, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    decision: r.decision,
    allowed: r.allowed,
    source: r.source,
    reason: r.reason,
    novel: r.novel,
    confidence: r.confidence,
    antibody_imm_id: r.antibodies[0]?.immId ?? null,
    antibody_imm_seq: r.antibodies[0]?.immSeq ?? null,
    check_id: r.checkId,
    ...extra,
  };
}

const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
