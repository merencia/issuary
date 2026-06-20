import { Command } from "commander";
import { createRequire } from "node:module";
import { registerCommands } from "./commands/index.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string; description: string };

/**
 * Builds the root `lore` command with all subcommands registered.
 * Kept separate from {@link file://./cli.ts} so it can be exercised in tests
 * without spawning a process.
 */
export function createProgram(): Command {
  const program = new Command();

  program.name("lore").description(pkg.description).version(pkg.version);

  registerCommands(program);

  return program;
}
