import type { Command } from "commander";
import { compactCommand } from "./compact.js";
import { repoDigestCommand } from "./repo-digest.js";
import { showCommand } from "./show.js";

/**
 * Wires every subcommand onto the root program.
 *
 * Each feature task adds its command module under `src/commands/` and registers
 * it here. This is the single, intentional merge point for new commands.
 */
export function registerCommands(program: Command): void {
  // Commands are added by feature tasks (add, remove, list, sync, digest,
  // repo-digest, show, compact, protocol). See .local/TASKS.md.
  program.addCommand(compactCommand());
  program.addCommand(repoDigestCommand());
  program.addCommand(showCommand());
}
