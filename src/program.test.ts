import { describe, expect, it } from "vitest";
import { createProgram } from "./program.js";

describe("createProgram", () => {
  it("is named issuary", () => {
    expect(createProgram().name()).toBe("issuary");
  });

  it("exposes a version", () => {
    expect(createProgram().version()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
