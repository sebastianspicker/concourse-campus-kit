# Institution packs

An institution pack holds the public identity, campuses, rooms, source URLs,
timezone, and client presentation defaults for one institution. Packs live in
`packages/institutions/src/packs/` and are registered in
`packages/institutions/src/registry.ts`.

| ID | Use |
|---|---|
| `example` | Fictional static-demo and public example pack |
| `hfmt` | Public HfMT configuration |
| `mockuni` | Deterministic test configuration |

## The contract

`InstitutionPackSchema` in `packages/institutions/src/schema.ts` validates:

- `id`, `name`, `type`, and `campuses`
- optional `publicRooms`
- optional `publicSources.events` and `publicSources.schedules`
- a required IANA `timezone`; the API and the client read every source time and
  the campus day in this zone
- optional `app.displayName`, `app.defaultLocale`, `app.designPreset`, and an
  accessible `app.accent`: a six-digit hex color used as a flat fill. It needs
  4.5:1 against black or white text and must stand out from every light preset
  canvas (1.2:1). Vivid flats and deep institutional colors both qualify; the
  client derives a readable tint wherever the color has to work as text

The contract imports room DTOs from `@concourse/contracts`. Supported design
presets are `wayfinding`, `atelier`, and `precision`; a pack without a preset
resolves to `wayfinding` in the client. See the
[design reference](../DESIGN.md) for accent and presentation rules.

## Add a pack

1. Copy `packages/institutions/src/packs/example.public.ts`.
2. Give it a unique ID and use only public, non-sensitive data.
3. Register it in `packages/institutions/src/registry.ts`.
4. Set the same `INSTITUTION_ID` for the API and client builds.
5. Exercise the Today, Events, Rooms, Schedule, Settings, and detail routes.
6. Run `pnpm --filter @concourse/institutions test` and `pnpm verify`.

A pack with no events config makes `/events` unavailable, no schedules makes
`/schedule` unavailable, and no rooms makes `/rooms` unavailable. Today needs at
least event sources or rooms. Packs must not contain credentials, private
endpoints, internal identifiers, access instructions, or personal data.
