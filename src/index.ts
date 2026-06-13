#!/usr/bin/env node
import { Agent } from "./agent.js";
import { ConfigError, loadConfig } from "./config.js";
import { createLogger } from "./log.js";

const log = createLogger("main");

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error(`configuration error: ${err.message}`);
      log.error("see README.md for the env reference; the agent needs at least AGENT_ROLE + AGENT_WALLET_KEY");
      process.exit(2);
    }
    throw err;
  }

  const agent = new Agent(cfg);
  await agent.start();

  const shutdown = (signal: string): void => {
    log.info(`received ${signal}, shutting down`);
    agent.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  log.error("fatal", { error: String(err) });
  process.exit(1);
});
