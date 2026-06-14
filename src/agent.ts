import type { AgentConfig } from "./config.js";
import { startImmunity } from "./immunity.js";
import { createLogger } from "./log.js";
import { Reporter } from "./reporter.js";
import { selectStrategy } from "./roles/index.js";
import { type Strategy, type StrategyContext, recordVia } from "./strategy.js";
import { runCommand } from "./commands.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Uniform random integer in [min, max] (clamps if a misconfig flips them). */
const randSpan = (min: number, max: number): number => {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
};

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
      tickMinMs: this.#cfg.tickMinMs,
      tickMaxMs: this.#cfg.tickMaxMs,
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

    // Playground command loop — a SEPARATE fast poll (default 15s) so judge
    // actions get a few-second response regardless of the slow, randomized act
    // cadence. Runs even while the fleet is "paused" (judge actions are explicit).
    void this.#commandLoop(ctx);
  }

  async #commandLoop(ctx: StrategyContext): Promise<void> {
    if (this.#cfg.apiUrl === undefined) return; // no API → no playground
    const pollMs = Number(process.env.AGENT_COMMAND_POLL_MS) || 15000;
    while (this.#running) {
      try {
        const cmd = await this.#reporter.nextCommand();
        if (cmd) {
          this.#log.info("running playground command", { id: cmd.id, type: cmd.commandType });
          let result;
          try {
            result = await runCommand(cmd, ctx);
          } catch (err) {
            result = { status: "failed" as const, detail: { error: String(err).slice(0, 200) } };
          }
          await this.#reporter.completeCommand(cmd.id, result.status, result.detail);
          continue; // drain the queue fast — don't sleep between queued commands
        }
      } catch (err) {
        this.#log.warn("command loop error", { error: String(err) });
      }
      await sleep(pollMs);
    }
  }

  #pausedLogged = false;

  /**
   * Act loop, pause-responsive. The pause flag is polled on a FAST fixed
   * interval (CONTROL_POLL, ~15s) decoupled from the slow random act cadence —
   * so the judge's start/stop button takes effect within seconds, not up to a
   * full 3-12min tick. The act timer only counts down while NOT paused; the
   * paused state is mirrored to the reporter so the UI shows "paused".
   */
  async #loop(ctx: StrategyContext): Promise<void> {
    const POLL = Number(process.env.AGENT_CONTROL_POLL_MS) || 15000;
    let actIn = randSpan(this.#cfg.tickMinMs, this.#cfg.tickMaxMs);
    while (this.#running) {
      let paused = false;
      try {
        paused = await this.#reporter.controlPaused();
      } catch {
        paused = false; // fail-open: a control outage must not freeze the fleet
      }
      this.#reporter.setPaused(paused);
      if (paused) {
        if (!this.#pausedLogged) {
          this.#log.info("fleet paused — idling");
          this.#pausedLogged = true;
        }
      } else {
        if (this.#pausedLogged) {
          this.#log.info("fleet resumed — acting");
          this.#pausedLogged = false;
        }
        actIn -= POLL;
        if (actIn <= 0) {
          try {
            await this.#strategy.tick(ctx);
          } catch (err) {
            this.#log.error("tick threw", { error: String(err) });
          }
          actIn = randSpan(this.#cfg.tickMinMs, this.#cfg.tickMaxMs);
        }
      }
      await sleep(POLL);
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
