/** Characterizes color-scheme resolution and institution accent contrast handling. */
import { describe, expect, it } from "vitest";
import { getContrastRatio } from "@concourse/institutions";
import { applyInstitutionAccent, getThemeForScheme, readableTint, resolveColorScheme } from "../themeResolve";
import { colorSchemes } from "../theme";

describe("resolveColorScheme", () => {
  it("honors explicit preferences and follows only a dark system scheme", () => {
    expect(resolveColorScheme("dark", "light")).toBe("dark");
    expect(resolveColorScheme("highContrast", "dark")).toBe("highContrast");
    expect(resolveColorScheme("system", "dark")).toBe("dark");
    expect(resolveColorScheme("system", "light")).toBe("light");
    expect(resolveColorScheme("system", "unspecified")).toBe("light");
    expect(resolveColorScheme("system", null)).toBe("light");
  });
});

describe("getThemeForScheme", () => {
  it("flags non-light schemes dark and ignores presets in high contrast", () => {
    expect(getThemeForScheme("light").isDark).toBe(false);
    expect(getThemeForScheme("dark").isDark).toBe(true);
    const hc = getThemeForScheme("highContrast", "atelier");
    expect(hc.isDark).toBe(true);
    expect(hc.colors).toBe(colorSchemes.highContrast);
    expect(hc.colorScheme).toBe("highContrast");
    expect(hc.designPreset).toBe(getThemeForScheme("highContrast").designPreset);
  });
});

describe("applyInstitutionAccent", () => {
  const light = getThemeForScheme("light");

  it("returns the theme unchanged without an accent or in high contrast", () => {
    expect(applyInstitutionAccent(light)).toBe(light);
    const hc = getThemeForScheme("highContrast");
    expect(applyInstitutionAccent(hc, "#123456")).toBe(hc);
  });

  it("uses a sufficiently contrasting accent and derives readable text", () => {
    const themed = applyInstitutionAccent(light, "#000000");
    expect(themed.colors.accent).toBe("#000000");
    expect(themed.colors.accentText).toBe("#FFFFFF");
  });

  it("darkens a pale accent until it reads on the light canvases", () => {
    const themed = applyInstitutionAccent(light, "#8FA9E6");
    expect(getContrastRatio(themed.colors.accent, light.colors.background)).toBeGreaterThanOrEqual(4.5);
    expect(getContrastRatio(themed.colors.accent, light.colors.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps a deep accent as the band and derives a readable tint in dark mode", () => {
    const dark = getThemeForScheme("dark");
    const themed = applyInstitutionAccent(dark, "#1B3A6B");
    expect(themed.colors.brand).toBe("#1B3A6B");
    expect(getContrastRatio(themed.colors.brandText, themed.colors.brand)).toBeGreaterThanOrEqual(4.5);
    expect(themed.colors.accent).not.toBe("#1B3A6B");
    expect(getContrastRatio(themed.colors.accent, dark.colors.background)).toBeGreaterThanOrEqual(4.5);
    expect(getContrastRatio(themed.colors.accent, dark.colors.surface)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("readableTint", () => {
  it("returns the color itself when it already reads on every canvas", () => {
    expect(readableTint("#1B3A6B", ["#F7F7F5"], false)).toBe("#1B3A6B");
  });

  it("lightens toward white on dark canvases", () => {
    const tint = readableTint("#1B3A6B", ["#0C111A", "#131A25"], true);
    expect(tint).toBeDefined();
    expect(getContrastRatio(tint ?? "", "#131A25")).toBeGreaterThanOrEqual(4.5);
  });
});
