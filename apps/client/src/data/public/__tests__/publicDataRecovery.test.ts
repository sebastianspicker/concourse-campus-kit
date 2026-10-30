import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelScheduledPublicDataRecovery,
  createRouteRecoveryObserver,
  registerPublicDataRecovery,
  schedulePublicDataRecovery,
  type PublicDataRecoveryState,
} from "../publicDataRecovery";

afterEach(() => {
  cancelScheduledPublicDataRecovery();
  vi.useRealTimers();
});

describe("public data recovery", () => {
  it("recovers persisted and transient failures after one coalesced reconnect burst", async () => {
    vi.useFakeTimers();
    const saved = vi.fn();
    const transient = vi.fn();
    const validation = vi.fn();
    const cleanups = [
      registerPublicDataRecovery({
        getState: () => ({ source: "persisted-cache", updatedAt: Date.now(), transientFailure: false, recoveryBlocked: false }),
        recover: saved,
      }),
      registerPublicDataRecovery({
        getState: () => ({ source: null, updatedAt: null, transientFailure: true, recoveryBlocked: false }),
        recover: transient,
      }),
      registerPublicDataRecovery({
        getState: () => ({ source: "persisted-cache", updatedAt: null, transientFailure: false, recoveryBlocked: true }),
        recover: validation,
      }),
    ];

    schedulePublicDataRecovery("reconnect");
    schedulePublicDataRecovery("reconnect");
    await vi.advanceTimersByTimeAsync(750);

    expect(saved).toHaveBeenCalledTimes(1);
    expect(transient).toHaveBeenCalledTimes(1);
    expect(validation).not.toHaveBeenCalled();
    cleanups.forEach((cleanup) => cleanup());
  });

  it("refreshes network-backed data older than sixty seconds on foreground or focus", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T10:00:00Z"));
    const old = vi.fn();
    const recent = vi.fn();
    const state = (age: number): PublicDataRecoveryState => ({
      source: "network",
      updatedAt: Date.now() - age,
      transientFailure: false,
      recoveryBlocked: false,
    });
    const cleanups = [
      registerPublicDataRecovery({ getState: () => state(60_001), recover: old }),
      registerPublicDataRecovery({ getState: () => state(59_999), recover: recent }),
    ];

    schedulePublicDataRecovery("foreground");
    schedulePublicDataRecovery("reconnect");
    await vi.advanceTimersByTimeAsync(750);

    expect(old).toHaveBeenCalledTimes(1);
    expect(recent).not.toHaveBeenCalled();
    cleanups.forEach((cleanup) => cleanup());
  });

  it("cancels a queued recovery when saved data is cleared", async () => {
    vi.useFakeTimers();
    const recover = vi.fn();
    const cleanup = registerPublicDataRecovery({
      getState: () => ({ source: "persisted-cache", updatedAt: Date.now(), transientFailure: false, recoveryBlocked: false }),
      recover,
    });

    schedulePublicDataRecovery("reconnect");
    cancelScheduledPublicDataRecovery();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(recover).not.toHaveBeenCalled();
    cleanup();
  });

  it("schedules recovery only after navigation changes the focused route", () => {
    const schedule = vi.fn();
    const observeRoute = createRouteRecoveryObserver(schedule);

    observeRoute("/settings");
    observeRoute("/settings");
    expect(schedule).not.toHaveBeenCalled();

    observeRoute("/");
    expect(schedule).toHaveBeenCalledTimes(1);
  });
});
