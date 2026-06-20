import type { Command } from "commander";
import { addCommand } from "./add.js";
import { compactCommand } from "./compact.js";
import { listCommand } from "./list.js";
import { protocolCommand } from "./protocol.js";
import { removeCommand } from "./remove.js";
import { repoDigestCommand } from "./repo-digest.js";
import { showCommand } from "./show.js";
import { syncCommand } from "./sync.js";

/**
 * Wires every subcommand onto the root program.
 *
 * Each feature task adds its command module under `src/commands/` and registers
 * it here. This is the single, intentional merge point for new commands.
 */
export function registerCommands(program: Command): void {
  // Commands are added by feature tasks (add, remove, list, sync, digest,
  // repo-digest, show, compact, protocol). See .local/TASKS.md.
  program.addCommand(addCommand());
  program.addCommand(removeCommand());
  program.addCommand(listCommand());
  program.addCommand(compactCommand());
  program.addCommand(protocolCommand());
  program.addCommand(repoDigestCommand());
  program.addCommand(showCommand());
  program.addCommand(syncCommand());
}
