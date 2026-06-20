import { Command } from "commander";
import { COMPACT_FORMAT_SPEC, COMPACTION_PROTOCOL, type CompactFormatSpec } from "../protocol/index.js";

/** The shape of the `lore protocol --json` output. */
export interface ProtocolJson {
  /** The full compaction protocol text. */
  protocol: string;
  /** Structured, machine-readable description of the canonical compact format. */
  compactFormat: CompactFormatSpec;
}

/**
 * Core action for `lore protocol`: returns the canonical compaction protocol.
 *
 * Separated from the Commander wiring so it can be tested without spawning a
 * process. Returns the human text, or the structured JSON payload when
 * `options.json` is set.
 */
export function runProtocol(options: { json?: boolean } = {}): string | ProtocolJson {
  if (options.json) {
    return { protocol: COMPACTION_PROTOCOL, compactFormat: COMPACT_FORMAT_SPEC };
  }
  return COMPACTION_PROTOCOL;
}

/**
 * Builds the `protocol` command. It prints the AI compaction contract so an
 * agent can discover the protocol it must follow.
 *
 * @see file://../../docs/compact-format.md
 */
export function protocolCommand(): Command {
  return new Command("protocol")
    .description("Print the AI compaction protocol (the contract AI consumers follow)")
    .option("--json", "emit machine-readable JSON")
    .action((options: { json?: boolean }) => {
      if (options.json) {
        console.log(JSON.stringify(runProtocol({ json: true })));
      } else {
        console.log(runProtocol());
      }
    });
}
