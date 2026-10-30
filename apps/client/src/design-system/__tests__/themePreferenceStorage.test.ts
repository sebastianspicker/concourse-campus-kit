/** Characterizes persisted theme preference loading and the legacy accessibility migration. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => new Map<string, string>());

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => store.get(key) ?? null,
    setItem: async (key: string, value: string) => void store.set(key, value),
    removeItem: async (key: string) => void store.delete(key),
  },
}));

import {
  THEME_PREFERENCE_STORAGE_NAME,
  isThemePreference,
  loadThemePreference,
  saveThemePreference,
} from "../themePreferenceStorage";

const LEGACY_KEY = "@campus-app/theme-preference";

describe("themePreferenceStorage", () => {
  beforeEach(() => store.clear());

  it("validates stored strings", () => {
    expect(isThemePreference("dark")).toBe(true);
    expect(isThemePreference("accessibility")).toBe(false);
    expect(isThemePreference(null)).toBe(false);
  });

  it("returns null when nothing or an unknown value is stored", async () => {
    expect(await loadThemePreference()).toBeNull();
    store.set(THEME_PREFERENCE_STORAGE_NAME, "sepia");
    expect(await loadThemePreference()).toBeNull();
  });

  it("round-trips a saved preference", async () => {
    await saveThemePreference("dark");
    expect(await loadThemePreference()).toBe("dark");
  });

  it("migrates the legacy accessibility value to highContrast under the new key", async () => {
    store.set(LEGACY_KEY, "accessibility");
    expect(await loadThemePreference()).toBe("highContrast");
    expect(store.get(THEME_PREFERENCE_STORAGE_NAME)).toBe("highContrast");
    expect(store.has(LEGACY_KEY)).toBe(false);
  });

  it("maps a current-key accessibility value to highContrast", async () => {
    store.set(THEME_PREFERENCE_STORAGE_NAME, "accessibility");
    expect(await loadThemePreference()).toBe("highContrast");
  });
});
