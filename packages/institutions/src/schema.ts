import { isPublicHttpUrl, RoomSchema } from "@concourse/contracts";
import { z } from "zod";
import { InstitutionDesignPresetSchema, isAccessibleInstitutionAccent } from "./branding";

/** Uses the platform timezone database so invalid institution configuration fails early. */
function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export const InstitutionPackSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  campuses: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      city: z.string(),
      address: z.string(),
      labels: z.array(z.string())
    })
  ),
  publicSources: z
    .object({
      events: z.array(z.object({ label: z.string(), url: z.string().url().refine(isPublicHttpUrl, "Public source URLs must be public, credential-free HTTP(S) URLs") })).optional(),
      schedules: z.array(z.object({ label: z.string(), url: z.string().url().refine(isPublicHttpUrl, "Public source URLs must be public, credential-free HTTP(S) URLs") })).optional()
    })
    .optional(),
  publicRooms: z.array(RoomSchema).optional(),
  timezone: z.string().refine(isValidTimeZone, "Invalid IANA timezone"),
  app: z
    .object({
      displayName: z.string().trim().min(1).optional(),
      defaultLocale: z.enum(["en", "de"]).optional(),
      designPreset: InstitutionDesignPresetSchema.optional(),
      accent: z
        .string()
        .regex(/^#[0-9a-f]{6}$/i, "Accent must be a six-digit hex color")
        .refine(isAccessibleInstitutionAccent, "Accent does not meet contrast requirements")
        .optional()
    })
    .optional()
});

export type InstitutionPack = z.infer<typeof InstitutionPackSchema>;
