import { describe, expect, it } from "vitest";
import { COMPACT_FORMAT_SPEC, COMPACTION_PROTOCOL } from "../protocol/index.js";
import { runProtocol } from "./protocol.js";

describe("runProtocol", () => {
  it("returns the protocol text by default", () => {
    expect(runProtocol()).toBe(COMPACTION_PROTOCOL);
  });

  it("returns the protocol text when json is not set", () => {
    expect(runProtocol({})).toBe(COMPACTION_PROTOCOL);
  });

  it("returns a structured payload with --json", () => {
    expect(runProtocol({ json: true })).toEqual({
      protocol: COMPACTION_PROTOCOL,
      compactFormat: COMPACT_FORMAT_SPEC,
    });
  });

  it("emits json that round-trips through JSON.stringify", () => {
    const json = runProtocol({ json: true });
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });
});
