import { describe, expect, it } from "vitest";
import { createLatestResultGuard } from "../requestGuard";

describe("latest async result guard", () => {
  it("rejects an older completion after a newer snapshot starts", () => {
    const guard = createLatestResultGuard();
    const beforeClear = guard.begin();
    const afterClear = guard.begin();

    expect(guard.accepts(beforeClear)).toBe(false);
    expect(guard.accepts(afterClear)).toBe(true);
  });

  it("rejects every completion after unmount and can remount under strict effects", () => {
    const guard = createLatestResultGuard();
    const request = guard.begin();
    guard.unmount();
    expect(guard.accepts(request)).toBe(false);
    guard.mount();
    expect(guard.accepts(request)).toBe(false);
    expect(guard.accepts(guard.begin())).toBe(true);
  });
});
