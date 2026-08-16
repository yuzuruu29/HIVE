# Astryx Hybrid Adoption — HIVE Cloud

## Why Astryx

HIVE Cloud had no shared UI primitives: 8 independent dialog implementations with duplicated focus-traps, bare HTML inputs across 10+ surfaces, and no data-grid patterns. Astryx provides production-grade, accessible primitives without requiring a full styling framework adoption.

## Installed Versions (Pinned)

| Package | Version |
|---------|---------|
| `@astryxdesign/core` | 0.1.7 |
| `@astryxdesign/theme-neutral` | 0.1.7 |
| `@astryxdesign/cli` | 0.1.7 (dev) |

## Adopted Surfaces

| Surface | Astryx Components | File |
|---------|-------------------|------|
| General Settings | TextArea, TextInput, NumberInput, Spinner | `components/general-settings-surface.tsx` |
| Beta Admin | Table, Badge, EmptyState, TextInput, NumberInput | `components/admin-surface.tsx` |
| Share Dialog | Dialog, DialogHeader | `components/share-dialog.tsx` |

## Intentionally HIVE-Native

AppShell, ChatSurface, ChatInterface, HiveThinkingBlock, HiveWaveBackground, HiveWelcomeState, ModelPicker, BuildSurface, CouncilExecutionPanel, ProvidersSurface, ApiKeysSurface, BillingSurface, UsageSurface, ConversationList, Landing components, RouteVisual, BranchNavigator, CodeBlock, MarkdownMessage, Reveal, all GSAP/Three.js choreography.

## Architecture

### CSS Cascade Layers

```
@layer reset, theme, base, astryx-base, astryx-theme, components, utilities;

@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/preflight.css" layer(base);
@import "@astryxdesign/core/reset.css";          # @layer reset
@import "@astryxdesign/core/astryx.css";          # @layer astryx-base
@import "@astryxdesign/theme-neutral/theme.css";  # CSS custom properties
@import "@astryxdesign/core/tailwind-theme.css";  # Token-to-utility bridge
@import "tailwindcss/utilities.css" layer(utilities);
```

### HIVE Theme Mapping

`apps/web/src/theme/hive-theme.tsx` — uses `defineTheme()` extending neutralTheme. Maps HIVE purple/void tokens to Astryx semantic names. Phosphor icons registered in Astryx icon registry.

### Provider Structure

```
RootLayout (Server) → Providers (Client) → Theme + LinkProvider → App
```

`next.config.ts` updated: `transpilePackages` + `optimizePackageImports` includes `@astryxdesign/core`.

### Phosphor Strategy

Dual icon system. Astryx uses Lucide internally (via theme-neutral). HIVE keeps Phosphor for all custom UI. No bulk migration.

### Wrapper Boundary

`components/ui/hive-*.tsx` — wrapper components around Astryx primitives. Feature code imports wrappers, not Astryx directly (except tightly isolated pilots).

## Upgrade Workflow

```bash
npm install @astryxdesign/core@new-version @astryxdesign/theme-neutral@new-version
npm run astryx upgrade --apply
npm run typecheck
npm test
```

## Rollback

1. Remove Astryx CSS imports from `globals.css`, restore `@import "tailwindcss"`
2. Remove `<Theme>`/`<LinkProvider>` from `Providers`
3. Replace Astryx component usage in migrated surfaces
4. Remove `@astryxdesign/core` from `transpilePackages`
5. `npm uninstall @astryxdesign/core @astryxdesign/theme-neutral @astryxdesign/cli`

## Known Beta Risks

- Astryx v0.1.7 is pre-1.0. Breaking changes expected between minors.
- `@scope` CSS not supported in Firefox (behind flag) — minor visual differences.
- Astryx Dialog uses native `<dialog>` element — jsdom tests need polyfills.
- defineTheme with unbuilt themes injects inline styles in dev; build for production.

## Future Candidates

- Provider surface: Selector for provider family, Password input for API keys, Switch for capabilities
- Usage surface: Data visualization (when Astryx charts stabilize)
- Chat tool-call blocks: Resizable panel for artifact inspector
- Billing surface: SelectableCard for plan selection

## Non-Goals

- Replace Phosphor with Lucide
- Adopt Astryx default visual identity
- Replace AppShell or chat experience
- Modify backend, billing, auth, or tenant isolation
