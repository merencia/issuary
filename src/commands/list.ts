import { Command } from "commander";
import { loadConfig } from "../config/index.js";
import { openStore, type Repo, type Store } from "../store/index.js";

/** Options for {@link runList}. */
export interface ListOptions {
  /** Emit machine-readable JSON instead of human text. */
  json?: boolean;
}

/** One repo as exposed by `issuary list --json`. */
export interface ListItem {
  repo: string;
  active: boolean;
  /** ISO-8601 timestamp of the last successful sync, or null when never synced. */
  lastSyncedAt: string | null;
}

/**
 * Core action for `issuary list`: returns the watched repos and their state,
 * ordered by `full_name`. Separated from the Commander wiring for testing.
 */
export function runList(store: Store): ListItem[] {
  return store.listRepos().map((repo: Repo) => ({
    repo: repo.fullName,
    active: repo.active,
    lastSyncedAt: repo.lastSyncedAt,
  }));
}

/**
 * Renders the human-readable, aligned listing. Repos are grouped active first,
 * then inactive; `last_synced_at` shows "never" when null.
 */
export function formatList(items: ListItem[]): string {
  if (items.length === 0) {
    return "No repos watched yet. Add one with `issuary add owner/repo`.";
  }

  const active = items.filter((item) => item.active);
  const inactive = items.filter((item) => !item.active);
  const width = Math.max(...items.map((item) => item.repo.length));

  const lines: string[] = [];
  const render = (item: ListItem): string =>
    `  ${item.repo.padEnd(width)}  last synced: ${item.lastSyncedAt ?? "never"}`;

  if (active.length > 0) {
    lines.push("active:");
    for (const item of active) {
      lines.push(render(item));
    }
  }
  if (inactive.length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push("inactive:");
    for (const item of inactive) {
      lines.push(render(item));
    }
  }
  return lines.join("\n");
}

/** Builds the `list` command. */
export function listCommand(): Command {
  return new Command("list")
    .description("List watched repos with their state and last sync time")
    .option("--json", "emit machine-readable JSON")
    .action((options: ListOptions) => {
      const config = loadConfig({ requireToken: false });
      const store = openStore(config.dbPath);
      try {
        const items = runList(store);
        if (options.json) {
          console.log(JSON.stringify(items));
        } else {
          console.log(formatList(items));
        }
      } finally {
        store.close();
      }
    });
}
