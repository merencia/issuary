import { Command } from "commander";
import { createRequire } from "node:module";
import { registerCommands } from "./commands/index.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string; description: string };

/**
 * Builds the root `issuary` command with all subcommands registered.
 * Kept separate from {@link file://./cli.ts} so it can be exercised in tests
 * without spawning a process.
 */
export function createProgram(): Command {
  const program = new Command();

  program.name("issuary").description(pkg.description).version(pkg.version);

  // Discoverability only: the flag is resolved at module load in render/style.ts
  // by reading process.argv directly, so formatters that run before Commander
  // parses still see it. Declared here so it shows up in --help and is accepted.
  program.option("--no-color", "disable colored output");

  registerCommands(program);

  program.addHelpText(
    "after",
    "\nAI consumers: run `issuary protocol` for the compaction contract (how to use, when to\nrecompact, and how to persist a compact). Add `--json` for the machine-readable form.\nAI agents: run `issuary skill --install` to install issuary as a discoverable agent skill.",
  );

  return program;
}
