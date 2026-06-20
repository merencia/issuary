import { describe, expect, it } from "vitest";
import { createProgram } from "./program.js";

describe("createProgram", () => {
  it("is named lore", () => {
    expect(createProgram().name()).toBe("lore");
  });

  it("exposes a version", () => {
    expect(createProgram().version()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
