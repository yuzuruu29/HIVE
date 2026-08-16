# Cinematic Demo Video — Design

**Date:** 2026-07-20
**Status:** Approved for implementation (user instructed to proceed)
**Replaces:** the existing `assets/demo/the-hive-skill-demo.html` slideshow + manual OBS/ffmpeg export

## Goal

Produce a cinematic, movie-trailer-style promotional video for The Hive Skill that
is rendered by a reproducible, one-command pipeline (no manual screen recording),
delivered as MP4 and an optimized GIF for the README badge, and adds a new
"live-run" beat that shows the six-role council actually processing a real task
end-to-end so the protocol is tangible rather than abstract.

## Locked-in creative decisions

These were chosen during brainstorming (visual companion + terminal):

1. **Direction: Cinematic / movie-trailer.** Letterboxed, film grain, vignette,
   bold kinetic typography on near-black. Dramatic, high-contrast, AAA-product feel.
2. **Palette: Ember.** Warm amber-to-orange glow rising from below, like a hive lit
   from within. Primary `#FFB347`, accent `#FF6B35`, deep ground `#0A0506`, with
   per-role accent colors retained for the council beat.
3. **Content: Add a live-run beat.** The council is shown processing a real task
   end-to-end (the documented login-form bugfix example), with authentic handoff
   YAML, evidence-ledger rows, and confidence labels, terminating on a COMPLETE
   stop-condition card.
4. **Formats: MP4 (automated render) + GIF (for README).** No manual OBS.

## Approach chosen: Remotion

A Remotion 4.x composition renders the film frame-accurately to MP4; ffmpeg then
produces the GIF. Remotion's Chromium-based renderer replaces the prior
Playwright-frame-capture idea and outputs MP4 directly.

### Why Remotion over the HTML+Playwright alternative

- Purpose-built timeline/sequencing primitives (`Sequence`, `useCurrentFrame`,
  `interpolate`, spring animations) beat hand-rolling a `requestAnimationFrame`
  timeline for a multi-beat film.
- A single `npx remotion render` call replaces frame-by-frame screenshot stitching,
  yielding a deterministic MP4 in one pass.
- The composition remains inspectable in `npx remotion studio` for live tweaking.

### Verified constraint (de-risking smoke test, 2026-07-20)

Remotion 4.0.494 installs and renders end-to-end on Node v24.15.0 / win32-x64.
**One hard pin is required:** `typescript` must be `~5.9` (NOT 7.x). TypeScript 7.0.2
shipped a new package layout where `require('typescript')` resolves to a stub
`./lib/version.cjs` exposing only `{version}` and no `sys`, which makes Remotion's
`esbuild-loader` throw `Cannot read properties of undefined (reading 'readFile')`
at `readConfigFile(tsConfigPath, typescript.sys.readFile)`. TypeScript 5.9.3
restores `ts.sys` and the render completes (`RENDER_OK`, 30 frames @ 30fps).

This pin must be enforced in the workspace `package.json` and documented in the
render readme so a future `npm update typescript` cannot silently break the build.

## Film structure

Target duration: ~38 seconds at 30fps (≈1140 frames), 1920×1080, letterboxed to
an effective 1920×816 frame (top + bottom 132px black bars) for the cinematic
look. Each beat is a Remotion `<Sequence>`.

| # | Beat | Frames @30fps | Duration | Content |
|---|------|---------------|----------|---------|
| 1 | Cold open | 0–89 | 3.0s | Black, film grain fades in, "AUTONOMOUS · MULTI-AGENT · COUNCIL" letterspaced subtitle, embers drift up. |
| 2 | Title | 90–209 | 4.0s | "THE HIVE" kinetic typography: letters rise with bloom from below the lower letterbox, ember glow swells behind. v0.3.0 · Apache-2.0 badge. |
| 3 | Problem | 210–329 | 4.0s | Three punch-in cards: "No Structure", "Token Waste", "No Stop Rules" — each slams in with a flash + grain kick. |
| 4 | Six Roles | 330–489 | 5.3s | Six role cards (Queen/Scout/Architect/Forger/Sentinel/Scribe) assemble in a council arc, each with its emoji, name, one-line mandate, and accent color. Cards ignite sequentially with ember sparks. |
| 5 | **Live-Run** | 490–839 | 11.6s | The signature beat. See "Live-Run beat" below. |
| 6 | Why it works | 840–959 | 4.0s | Four feature pillars fade in: Token Efficient, Safety Boundaries, Structured Handoffs, Protocol Autonomy. |
| 7 | CTA | 960–1139 | 6.0s | Install command typed in a terminal pane, "Join the Hive", GitHub + docs links, built-by line. Loop fade. |

Total: 1140 frames = 38.0s.

## Live-Run beat (signature)

This is the beat that earns the video. It visualizes the **login-form bugfix
example** from `skills/hive-mind-council/examples/bugfix.md` using the real
artifacts from the protocol — not invented content.

**Layout (within the letterboxed frame):**
- Left ~62%: a "council rail" — the six role cards in a vertical stack. The
  active role's card ignites (ember border + glow) as its turn begins; completed
  roles show a checkmark with their confidence label.
- Right ~38%: a scrolling "evidence pane" styled like a terminal/log. As each
  role completes, its handoff summary line + key finding + confidence tag types
  in, and a row appends to an evidence ledger table at the bottom of the pane.

**Sequence within the beat (11.6s):**

1. **Queen (0–1.6s):** Run-contract YAML types in at top of evidence pane:
   `goal: Fix login form error message display`, `execution_mode: standard`,
   `maximum_fix_cycles: 2`. Queen card ignites → checkmark, confidence: high.
2. **Scout (1.6–3.4s):** Handoff line: "Error state exists but is not rendered in
   JSX." Finding tagged **high** (confirmed by code inspection). Files examined:
   `src/components/LoginForm.tsx`. Scout card → checkmark.
3. **Architect (3.4–5.2s):** Plan types in: "Add error message JSX block; update
   test assertions." Risk: low. File scope assigned. Architect card → checkmark.
4. **Forger (5.2–7.4s):** Patch manifest: 2 files changed. Command runs with a
   progress flash: `npm test -- LoginForm` → **passed**. Forger card → checkmark.
5. **Sentinel (7.4–9.4s):** Validation layers tick: static ✓, tests ✓ (15 passed,
   0 failed), behavioral ✓, safety ✓. Verdict: **PASS**. Sentinel card → checkmark.
6. **Scribe (9.4–10.6s):** "Fix documented. No README/changelog update needed."
   Scribe card → checkmark.
7. **Queen / stop (10.6–11.6s):** Final status card resolves in center:
   **COMPLETE — All success criteria satisfied with evidence.** Evidence ledger
   shows the full row set. The whole council rail glows ember as the run closes.

All confidence labels (`high`/`medium`/`low`), stop statuses (`complete`/
`partial`/`blocked`/`failed`), and handoff field names are taken verbatim from
`references/council-protocol.md` and `templates/role-handoff.yaml` so the beat is
a faithful, non-overclaiming visualization of what the protocol actually produces.

## Visual system (Ember theme)

- **Ground:** radial gradient `#0A0506` → near-black, with a warm
  `rgba(255,107,53,0.18)` glow rising from the bottom edge.
- **Letterbox:** fixed top + bottom black bars (132px each at 1080p) applied as a
  full-frame overlay so every beat is uniformly cinematic.
- **Film grain:** an animated noise overlay (~3–5% opacity, 6fps update) rendered
  via a pre-generated noise tile or a canvas Noise component, composited above
  content but below the letterbox.
- **Vignette:** radial darkening at the frame edges, ~30% strength.
- **Embers:** ~40 tiny amber particles drifting upward with sine sway and fade,
  behind the content layer, low opacity — the "hive lit from within" motif.
- **Kinetic type:** titles use `spring()` for entry; subtitle uses letterspaced
  uppercase with a slow opacity pulse.
- **Transitions:** hard cuts between beats with a 2-frame grain flash on cut;
  the title and the COMPLETE card get a 0.4s ember bloom swell.
- **Per-role accents (retained for the council and live-run beats):**
  Queen `#F6A623`, Scout `#22D3EE`, Architect `#A78BFA`, Forger `#FB923C`,
  Sentinel `#4ADE80`, Scribe `#60A5FA`. Each role's ember glow tints toward its
  accent when active.

## Repo layout

The Remotion workspace lives in a new `demo/` directory at the repo root, kept
separate from the existing `assets/demo/` (which holds the *outputs*):

```
demo/                          # Remotion source workspace (new)
  package.json                 # remotion, @remotion/cli, react, react-dom,
                               # typescript@~5.9 (PINNED), devDeps
  tsconfig.json                # jsx: react-jsx, moduleResolution: Bundler
  remotion.config.ts           # optional: set ffmpeg path, image format
  src/
    Root.tsx                   # registerRoot + <Composition> "HiveDemo"
    HiveDemo.tsx               # master composition: Sequence per beat
    theme.ts                   # ember palette, role accents, shared tokens
    components/
      Letterbox.tsx            # top+bottom black bars overlay
      Grain.tsx                # animated film-grain overlay
      Vignette.tsx
      Embers.tsx               # drifting amber particles (canvas or divs)
      KineticTitle.tsx         # reusable spring-driven title
      RoleCard.tsx             # council/live-run role card
    beats/
      ColdOpen.tsx
      Title.tsx
      Problem.tsx
      SixRoles.tsx
      LiveRun.tsx              # the signature beat
      WhyItWorks.tsx
      CTA.tsx
    data/
      runContract.ts           # the bugfix run-contract object
      handoffs.ts              # the six handoff summaries + findings
      roles.ts                 # role names, emojis, mandates, accents
  render.mjs                   # node script: bundle + renderMedia -> MP4
  scripts/
    render-mp4.mjs             # invokes render.mjs
    render-gif.sh              # ffmpeg MP4 -> optimized GIF
  README.md                    # how to preview (studio) and render

assets/demo/                   # outputs land here (existing dir)
  the-hive-skill-demo.mp4      # rendered video (new output)
  the-hive-skill-demo.gif      # regenerated GIF (replaces current)
  the-hive-skill-demo.html     # KEPT for now as a fallback reference
  export-instructions.md       # updated to describe the new one-command render
  README.md                    # updated
```

Rationale for `demo/` vs `assets/demo/`: source vs output separation keeps the
heavy Remotion `node_modules` out of the assets folder and makes the deliverable
files obvious. The old HTML is retained (not deleted) as a fallback reference and
is noted as superseded in its readme.

## Render pipeline (one-command)

`demo/package.json` scripts:

- `dev` → `remotion studio` (live preview at localhost:3000)
- `render:mp4` → `node scripts/render-mp4.mjs` (bundle + `renderMedia`, codec
  h264, 1920×1080, 30fps, CRF ~18) → writes
  `../assets/demo/the-hive-skill-demo.mp4`
- `render:gif` → `bash scripts/render-gif.sh` → ffmpeg reads the MP4 and writes
  `../assets/demo/the-hive-skill-demo.gif` using an optimized two-pass palette
  (fps 12, scale 960:-1, `palettegen`/`paletteuse` with bayer dither), matching
  the recommended settings already documented in `export-instructions.md`.
- `render` → `npm run render:mp4 && npm run render:gif` (the one-command build)

A convenience root-level `npm run render-demo` may be added to `package.json` to
`cd demo && npm run render`, but the demo workspace keeps its own
`node_modules`/lockfile so the pinned `typescript@~5.9` cannot leak into the main
repo's `ajv`-only dev dependencies.

## Testing / verification

- **Visual correctness:** `npx remotion studio` to scrub every beat; confirm
  timing, ember glow, grain, letterbox, and that the live-run handoff text
  matches `examples/bugfix.md` and `templates/role-handoff.yaml`.
- **Render reproducibility:** `npm run render` from clean `node_modules` produces
  the MP4 + GIF with no manual steps; assert both files exist and are non-trivial
  in size (MP4 > 500KB, GIF > 100KB).
- **Content fidelity check:** a grep assertion (or manual review) that the
  on-screen handoff summaries, confidence labels, and the COMPLETE stop-condition
  wording match the protocol references exactly — guards against overclaiming,
  which the project explicitly polices (see `WHAT_THIS_IS.md`, anti-overclaim
  contract checks).
- **No regression to existing CI:** the demo workspace is gitignored for its
  `node_modules` and build artifacts; the main repo `npm test` suite is untouched.
  New output files in `assets/demo/` are committed.

## Gitignore additions

- `.superpowers/` (already added this session for brainstorming mockups)
- `demo/node_modules/`
- `demo/out/` (any intermediate render output)
- `demo/.cache/` (Remotion bundler cache)

## Out of scope (YAGNI)

- Audio / voiceover / music — silent film only for v1.
- Multiple aspect ratios / vertical social cutdowns — 1920×1080 letterboxed only.
- A separate "real terminal capture" mode — the live-run beat is a faithful
  *visualization*, not a recording of an actual run (kept honest by sourcing
  text from the protocol docs).
- Localization — English only.
- Remotion Cloud Rendering — local render only.

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| `typescript` upgrades to 7.x and silently breaks the render | Pin `~5.9` in `demo/package.json`; document in `demo/README.md`; add a postinstall note. |
| Remotion Chromium download is large (~100MB) on first render | Expected; documented as a one-time cost. Already confirmed working in smoke test. |
| Live-run beat overclaims what the skill does | All on-screen text sourced verbatim from `examples/bugfix.md`, `council-protocol.md`, `role-handoff.yaml`; "visualization, not a recording" stated in demo readme; WHAT_THIS_IS boundary respected. |
| Render is slow (frame-accurate, ~38s video) | Acceptable for a reproducible pipeline; `render:mp4` is the slow step, `render:gif` is fast. Studio preview covers iteration without full renders. |
| Main repo `npm test` or CI breaks | Demo workspace is fully isolated (own package.json/node_modules); only committed outputs touch the main tree. |
