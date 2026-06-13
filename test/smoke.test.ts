import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { Reporter } from "../src/reporter.js";
import { selectStrategy } from "../src/roles/index.js";
import { createLogger } from "../src/log.js";
import { recordVia } from "../src/strategy.js";
import type { StrategyContext } from "../src/strategy.js";

const KEY = `0x${"1".repeat(64)}`;

function baseEnv(role: string): NodeJS.ProcessEnv {
  return {
    AGENT_ROLE: role,
    AGENT_WALLET_KEY: KEY,
    AGENT_LABEL: `test-${role}`,
    AGENT_TICK_MS: "1000",
    AGENT_HEARTBEAT_MS: "1000",
  };
}

test("loadConfig validates role + key and applies defaults", () => {
  const cfg = loadConfig(baseEnv("publisher"));
  assert.equal(cfg.role, "publisher");
  assert.equal(cfg.label, "test-publisher");
  assert.equal(cfg.tickMs, 1000);
  assert.equal(cfg.heartbeatMs, 1000);
  assert.equal(cfg.apiUrl, undefined);
});

test("loadConfig rejects an unknown role", () => {
  assert.throws(() => loadConfig({ ...baseEnv("wolf-trader") }), /AGENT_ROLE must be one of/);
});

test("loadConfig rejects a malformed wallet key", () => {
  assert.throws(
    () => loadConfig({ ...baseEnv("hunter"), AGENT_WALLET_KEY: "0xabc" }),
    /AGENT_WALLET_KEY must be/,
  );
});

test("selectStrategy returns the matching role module", () => {
  assert.equal(selectStrategy("publisher").role, "publisher");
  assert.equal(selectStrategy("hunter").role, "hunter");
  assert.equal(selectStrategy("corroborator").role, "corroborator");
});

test("reporter is a no-op without IMMUNITY_API_URL and builds the heartbeat payload otherwise", async () => {
  const cfg = loadConfig(baseEnv("publisher"));
  const offline = new Reporter(cfg, createLogger("test"));
  assert.equal(offline.enabled, false);
  // No throw, no network call when disabled.
  await offline.heartbeat();

  const captured: { url: string; body: unknown }[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    captured.push({ url, body: JSON.parse(String(init?.body)) });
    return { ok: true, status: 200 } as Response;
  }) as typeof fetch;

  try {
    const onlineCfg = loadConfig({ ...baseEnv("hunter"), IMMUNITY_API_URL: "https://api.example.test" });
    const online = new Reporter(onlineCfg, createLogger("test"));
    online.bindIdentity("0xWALLET", null);
    await online.heartbeat();
    await online.activity({ actionType: "check", actionSummary: "x", status: "allow" });
  } finally {
    globalThis.fetch = origFetch;
  }

  assert.equal(captured.length, 2);
  assert.match(captured[0]!.url, /\/v1\/agents\/heartbeat$/);
  const hb = captured[0]!.body as Record<string, unknown>;
  assert.equal(hb.role, "hunter");
  assert.equal(hb.wallet, "0xWALLET");
  assert.equal(hb.displayName, "test-hunter");
  assert.match(captured[1]!.url, /\/v1\/agents\/activity$/);
});

test("a strategy tick runs against a mocked SDK and records activity", async () => {
  const cfg = loadConfig(baseEnv("corroborator"));
  const strategy = selectStrategy("corroborator");

  const recorded: { actionType: string; status: string }[] = [];
  // Mock the SDK surface the corroborator touches.
  const im = {
    network: { chainId: 84532 },
    wallet: "0xWALLET",
    isRegistered: async () => false, // not registered → prepare disables writes, tick self-checks
    balanceOf: async () => 0n,
    check: async () => ({
      allowed: true,
      decision: "allow" as const,
      source: "policy" as const,
      confidence: 0,
      antibodies: [],
      reason: "",
      checkId: null,
      novel: false,
      txFacts: {} as never,
    }),
  };

  const ctx: StrategyContext = {
    cfg,
    // biome-ignore lint: structural mock of the SDK facade for offline testing
    im: im as never,
    wallet: "0xWALLET",
    log: createLogger("test"),
    record: (rec) => {
      recorded.push({ actionType: rec.actionType, status: rec.status });
    },
  };

  if (strategy.prepare) await strategy.prepare(ctx);
  await strategy.tick(ctx);

  // Not registered → the corroborator falls back to a self-check, which the
  // mock allows; the tick must record exactly one allow check and not throw.
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.actionType, "check");
  assert.equal(recorded[0]!.status, "allow");
});

test("recordVia never throws even if the reporter rejects", async () => {
  const cfg = loadConfig({ ...baseEnv("hunter"), IMMUNITY_API_URL: "https://api.example.test" });
  const reporter = new Reporter(cfg, createLogger("test"));
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  try {
    const record = recordVia(reporter, createLogger("test"));
    // Synchronous call, fire-and-forget — must not throw.
    record({ actionType: "check", actionSummary: "x", status: "error" });
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.ok(true);
});
