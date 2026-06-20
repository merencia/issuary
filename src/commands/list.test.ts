import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "../store/index.js";
import { formatList, type ListItem, runList } from "./list.js";

describe("runList", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("returns an empty array when nothing is watched", () => {
    expect(runList(store)).toEqual([]);
  });

  it("returns active and inactive repos with their last sync time", () => {
    store.insertRepo({ owner: "octo", name: "active", fullName: "octo/active" });
    store.insertRepo({ owner: "octo", name: "gone", fullName: "octo/gone" });
    store.setRepoActive("octo/gone", false);
    store.db
      .prepare(`UPDATE repos SET last_synced_at = ? WHERE full_name = ?`)
      .run("2024-05-01T00:00:00Z", "octo/active");

    const items = runList(store);

    expect(items).toEqual<ListItem[]>([
      { repo: "octo/active", active: true, lastSyncedAt: "2024-05-01T00:00:00Z" },
      { repo: "octo/gone", active: false, lastSyncedAt: null },
    ]);
  });
});

describe("formatList", () => {
  it("prints an empty hint when there are no repos", () => {
    expect(formatList([])).toContain("No repos watched");
  });

  it("groups active and inactive and shows never for null sync", () => {
    const text = formatList([
      { repo: "octo/active", active: true, lastSyncedAt: "2024-05-01T00:00:00Z" },
      { repo: "octo/gone", active: false, lastSyncedAt: null },
    ]);

    expect(text).toContain("active:");
    expect(text).toContain("octo/active");
    expect(text).toContain("2024-05-01T00:00:00Z");
    expect(text).toContain("inactive:");
    expect(text).toContain("octo/gone");
    expect(text).toContain("never");
  });
});
