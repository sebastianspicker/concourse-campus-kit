import { describe, expect, it } from "vitest";
import {
  INSTITUTION_DESIGN_CANVASES,
  InstitutionDesignPresetSchema,
  InstitutionPackSchema,
  isAccessibleInstitutionAccent
} from "../index";
import { getInstitutionPack } from "../registry";

describe("@concourse/institutions", () => {
  it("parses a minimal institution pack and rejects invalid time zones", () => {
    expect(() => InstitutionPackSchema.parse({
      id: "hfmt",
      name: "Example University",
      type: "music-and-dance",
      campuses: [],
      publicSources: { events: [], schedules: [] }
    })).not.toThrow();
    expect(() => InstitutionPackSchema.parse({
      id: "hfmt",
      name: "Example University",
      type: "music-and-dance",
      campuses: [],
      timezone: "not-a-timezone"
    })).toThrow();
  });

  it("accepts public HTTP(S) event and calendar source URLs", () => {
    expect(() => InstitutionPackSchema.parse({
      id: "hfmt",
      name: "Example University",
      type: "music-and-dance",
      campuses: [],
      publicSources: {
        events: [{ label: "Events", url: "https://www.example.org/events" }],
        schedules: [{ label: "Calendar", url: "https://www.example.org/calendar.ics" }]
      }
    })).not.toThrow();
  });

  it.each([
    "ftp://example.org/events",
    "https://reader:secret@example.org/events",
    "https://localhost/events",
    "https://intranet/events",
    "https://10.0.0.1/events",
    "https://[fc00::1]/events"
  ])("rejects unsafe public event and calendar source URL %s", (url) => {
    const basePack = {
      id: "hfmt",
      name: "Example University",
      type: "music-and-dance",
      campuses: []
    };

    expect(() => InstitutionPackSchema.parse({
      ...basePack,
      publicSources: { events: [{ label: "Events", url }] }
    })).toThrow();
    expect(() => InstitutionPackSchema.parse({
      ...basePack,
      publicSources: { schedules: [{ label: "Calendar", url }] }
    })).toThrow();
  });

  it("defines a light and dark validation canvas for every design preset", () => {
    expect(Object.keys(INSTITUTION_DESIGN_CANVASES).sort()).toEqual([...InstitutionDesignPresetSchema.options].sort());
    for (const canvases of Object.values(INSTITUTION_DESIGN_CANVASES)) {
      expect(canvases.light).toMatch(/^#[0-9A-F]{6}$/i);
      expect(canvases.dark).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });

  it("accepts supported design presets and rejects unknown ones", () => {
    expect(InstitutionDesignPresetSchema.options).toEqual(["wayfinding", "atelier", "precision"]);
    expect(() => InstitutionDesignPresetSchema.parse("unknown")).toThrow();
  });

  it("returns a schema-valid pack for known institution ids", () => {
    for (const institutionId of ["example", "hfmt", "mockuni"]) {
      const pack = getInstitutionPack(institutionId);
      expect(() => InstitutionPackSchema.parse(pack)).not.toThrow();
    }
  });

  it("throws for unknown institution ids", () => {
    expect(() => getInstitutionPack("does-not-exist")).toThrow(/Unknown institutionId/);
  });

  it("ships a working example for each design preset", () => {
    expect(getInstitutionPack("example").app?.designPreset).toBe("wayfinding");
    expect(getInstitutionPack("hfmt").app?.designPreset).toBe("atelier");
    expect(getInstitutionPack("mockuni").app?.designPreset).toBe("precision");
  });

  it("rejects institution accents that cannot identify controls accessibly", () => {
    expect(isAccessibleInstitutionAccent("#F6F6F6")).toBe(false);
    expect(isAccessibleInstitutionAccent("#12345")).toBe(false);
    expect(isAccessibleInstitutionAccent("#176B87")).toBe(true);
  });

  it("accepts vivid flats and deep institutional colors as fills", () => {
    expect(isAccessibleInstitutionAccent("#2A62F0")).toBe(true);
    expect(isAccessibleInstitutionAccent("#FF6A1A")).toBe(true);
    expect(isAccessibleInstitutionAccent("#1B3A6B")).toBe(true);
    expect(isAccessibleInstitutionAccent("#8F1D2C")).toBe(true);
  });
});
