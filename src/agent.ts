import type { AgentConfig } from "./config.js";
import { startImmunity } from "./immunity.js";
import { createLogger } from "./log.js";
import { Reporter } from "./reporter.js";
import { selectStrategy } from "./roles/index.js";
import { type Strategy, type StrategyContext, recordVia } from "./strategy.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The shared agent skeleton: SDK init → strategy `prepare()` → a check→decide→
 * act loop on `AGENT_TICK_MS` with an independent heartbeat on
 * `AGENT_HEARTBEAT_MS`. The role is a swappable strategy module — this skeleton
 * is identical for all three tier-1 roles.
 *
 * Returns a `stop()` handle so the loop is testable (and so SIGTERM can drain
 * cleanly in the container).
 */
export class Agent {
  readonly #cfg: AgentConfig;
  readonly #log = createLogger("agent");
  readonly #reporter: Reporter;
  readonly #strategy: Strategy;
  #running = false;
  #timers: NodeJS.Timeout[] = [];

  constructor(cfg: AgentConfig) {
    this.#cfg = cfg;
    this.#reporter = new Reporter(cfg, createLogger("reporter"));
    this.#strategy = selectStrategy(cfg.role);
  }

  /** Boot the SDK, prepare the strategy, and start the loop + heartbeat. */
  async start(): Promise<void> {
    this.#log.info("starting", {
      role: this.#cfg.role,
      label: this.#cfg.label,
      tickMs: this.#cfg.tickMs,
      heartbeatMs: this.#cfg.heartbeatMs,
      reporting: this.#reporter.enabled,
    });

    const im = await startImmunity(this.#cfg);
    const wallet = im.wallet;
    this.#reporter.bindIdentity(wallet, null);
    this.#log.info("sdk started", { wallet, chainId: im.network.chainId });

    const ctx: StrategyContext = {
      cfg: this.#cfg,
      im,
      wallet,
      log: createLogger(`role:${this.#cfg.role}`),
      record: recordVia(this.#reporter, this.#log),
      reportStatus: (status) => this.#reporter.setStatus(status),
    };

    if (this.#strategy.prepare) {
      await this.#strategy.prepare(ctx);
    }

    this.#running = true;
    // Fire one heartbeat immediately so the agent appears online without
    // waiting a full interval.
    void this.#reporter.heartbeat();

    this.#timers.push(
      setInterval(() => {
        void this.#reporter.heartbeat();
      }, this.#cfg.heartbeatMs),
    );

    // The act loop is awaited per tick (no overlapping ticks) on a recursive
    // timer rather than setInterval, so a slow tick never stacks.
    void this.#loop(ctx);
  }

  #pausedLogged = false;

  async #loop(ctx: StrategyContext): Promise<void> {
    while (this.#running) {
      try {
        // Fleet-wide pause (judge control): skip acting while paused — the
        // heartbeat keeps running on its own timer, so the agent stays online,
        // just idle. Resumes acting the moment the flag clears.
        if (await this.#reporter.controlPaused()) {
          if (!this.#pausedLogged) {
            this.#log.info("fleet paused — idling (heartbeat only)");
            this.#pausedLogged = true;
          }
        } else {
          if (this.#pausedLogged) {
            this.#log.info("fleet resumed — acting");
            this.#pausedLogged = false;
          }
          await this.#strategy.tick(ctx);
        }
      } catch (err) {
        this.#log.error("tick threw", { error: String(err) });
      }
      await sleep(this.#cfg.tickMs);
    }
  }

  /** Stop the loop + heartbeat. Idempotent. */
  stop(): void {
    this.#running = false;
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
    this.#log.info("stopped");
  }
}
