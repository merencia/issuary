import { describe, expect, it, vi } from "vitest";
import { runLogout } from "./logout.js";

describe("runLogout", () => {
  it("clears the stored token and reports removal", () => {
    const clearStoredToken = vi.fn().mockReturnValue(true);
    const result = runLogout({ home: "/tmp/issuary-home", clearStoredToken });
    expect(result).toEqual({ ok: true, removed: true });
    expect(clearStoredToken).toHaveBeenCalledWith("/tmp/issuary-home");
  });

  it("reports when there was nothing to remove", () => {
    const clearStoredToken = vi.fn().mockReturnValue(false);
    const result = runLogout({ home: "/tmp/issuary-home", clearStoredToken });
    expect(result).toEqual({ ok: true, removed: false });
  });
});
