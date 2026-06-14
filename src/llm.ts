/**
 * Minimal Anthropic client (no SDK dependency — just fetch). Used by wolves to
 * generate genuine-looking social-feed bait with a cheap, fast model. Best-effort:
 * any failure returns null so the caller falls back to a template.
 */
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
// Cheapest current model — wolves post often, content is short.
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export interface LlmResult {
  text: string;
}

export async function generate(opts: {
  system: string;
  prompt: string;
  maxTokens?: number;
}): Promise<LlmResult | null> {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  const model = process.env.AGENT_WOLF_MODEL?.trim() || DEFAULT_MODEL;
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens ?? 300,
        system: opts.system,
        messages: [{ role: "user", content: opts.prompt }],
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = (body.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("")
      .trim();
    return text ? { text } : null;
  } catch {
    return null;
  }
}

export function llmEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}
