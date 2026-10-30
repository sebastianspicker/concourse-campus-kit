/** Characterizes resource row interaction backgrounds. */
import { describe, expect, it } from "vitest";
import { getResourceRowBackground } from "../resourceRowBackground";
import { getThemeForScheme } from "../themeResolve";
import { withOpacity } from "../theme";

const theme = getThemeForScheme("light");

describe("getResourceRowBackground", () => {
  it("keeps rows transparent at rest and tints them with ink on hover and press", () => {
    expect(getResourceRowBackground(theme, false, false)).toBe("transparent");
    expect(getResourceRowBackground(theme, false, true)).toBe(withOpacity(theme.colors.text, 0.04));
    expect(getResourceRowBackground(theme, true, true)).toBe(withOpacity(theme.colors.text, 0.08));
  });
});
