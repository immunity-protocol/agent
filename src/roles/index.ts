import type { Role } from "../config.js";
import type { Strategy } from "../strategy.js";
import { AutoimmuneStrategy } from "./autoimmune.js";
import { CorroboratorStrategy } from "./corroborator.js";
import { HunterStrategy } from "./hunter.js";
import { PublisherStrategy } from "./publisher.js";

/**
 * Select the role strategy for this process. The role is the only thing that
 * differs between agents — everything else (SDK init, loop, heartbeat) is
 * shared. This is what makes it ONE image, role-selected by env.
 */
export function selectStrategy(role: Role): Strategy {
  switch (role) {
    case "publisher":
      return new PublisherStrategy();
    case "hunter":
      return new HunterStrategy();
    case "corroborator":
      return new CorroboratorStrategy();
    case "autoimmune":
      return new AutoimmuneStrategy();
  }
}
