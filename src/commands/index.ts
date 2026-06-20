import type { Command } from "commander";

/**
 * Wires every subcommand onto the root program.
 *
 * Each feature task adds its command module under `src/commands/` and registers
 * it here. This is the single, intentional merge point for new commands.
 */
export function registerCommands(_program: Command): void {
  // Commands are added by feature tasks (add, remove, list, sync, digest,
  // repo-digest, show, compact, protocol). See .local/TASKS.md.
}
