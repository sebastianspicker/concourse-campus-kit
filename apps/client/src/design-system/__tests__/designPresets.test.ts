import { describe, expect, it } from "vitest";
import { getContrastRatio } from "@concourse/institutions";
import { designPresets } from "../designPresets";
import { colorSchemes } from "../theme";

describe("institution design presets", () => {
  it("keeps the supported preset palettes and metrics distinct", () => {
    expect(designPresets.wayfinding.light.background).not.toBe(designPresets.atelier.light.background);
    expect(designPresets.wayfinding.light.background).not.toBe(designPresets.precision.light.background);
    expect(designPresets.atelier.dark.surface).not.toBe(designPresets.precision.dark.surface);
    expect(designPresets.atelier.metrics.rowMinHeight).toBeGreaterThan(designPresets.precision.metrics.rowMinHeight);
  });

  it("uses square print corners on every preset", () => {
    for (const preset of Object.values(designPresets)) {
      expect(preset.metrics.controlRadius).toBe(0);
      expect(preset.metrics.surfaceRadius).toBe(0);
    }
  });

  it("keeps primary and muted text readable on every preset canvas", () => {
    for (const preset of Object.values(designPresets)) {
      for (const palette of [preset.light, preset.dark]) {
        expect(getContrastRatio(palette.text, palette.background)).toBeGreaterThanOrEqual(4.5);
        expect(getContrastRatio(palette.muted, palette.background)).toBeGreaterThanOrEqual(4.5);
        expect(getContrastRatio(palette.muted, palette.surface)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps board type readable and control outlines visible", () => {
    for (const preset of Object.values(designPresets)) {
      for (const palette of [preset.light, preset.dark]) {
        expect(getContrastRatio(palette.boardText, palette.board)).toBeGreaterThanOrEqual(7);
        expect(getContrastRatio(palette.boardMuted, palette.board)).toBeGreaterThanOrEqual(4.5);
        expect(getContrastRatio(palette.controlBorder, palette.surface)).toBeGreaterThanOrEqual(3);
        expect(getContrastRatio(palette.controlBorder, palette.background)).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe("signal and status colors", () => {
  it("keep their foreground pairs readable in every scheme", () => {
    for (const colors of Object.values(colorSchemes)) {
      expect(getContrastRatio(colors.signalText, colors.signal)).toBeGreaterThanOrEqual(4.5);
      expect(getContrastRatio(colors.signal, colors.background)).toBeGreaterThanOrEqual(1.2);
      expect(getContrastRatio(colors.accentText, colors.accent)).toBeGreaterThanOrEqual(4.5);
      expect(getContrastRatio(colors.brandText, colors.brand)).toBeGreaterThanOrEqual(4.5);
      expect(getContrastRatio(colors.accent, colors.background)).toBeGreaterThanOrEqual(4.5);
      for (const [ink, wash] of [
        [colors.error, colors.errorSurface],
        [colors.success, colors.successSurface],
        [colors.warning, colors.warningSurface],
        [colors.info, colors.infoSurface],
      ]) {
        expect(getContrastRatio(ink, wash)).toBeGreaterThanOrEqual(4.5);
        expect(getContrastRatio(ink, colors.background)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
