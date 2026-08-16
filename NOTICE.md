# NOTICE — Vendored Code & Consolidation

This repository (`C:\HIVE`) is the consolidated home for the HIVE project. The
following related projects were merged into it on 2026-08-16. Their original
folders were moved (not permanently deleted) to `C:\_hive_archive_2026-08-16\`
as a reversible backup.

## Vendored into this repo

| Path | Source project | Upstream license | Notes |
|------|----------------|------------------|-------|
| `skills/hive-mind-council/` | `the-hive-skill` | Apache-2.0 | The built-in **hive skill** (six-role council protocol). |

`hive-cloud` (the HIVE Cloud web workspace, AGPL-3.0) is **not vendored here**.
Its source lives upstream at <https://github.com/yuzuruu29/hive-cloud>; a local
snapshot is archived in `C:\_hive_archive_2026-08-16\`. The optional
`hive-cloud` provider preset in HIVE talks to the deployed cloud API by URL
and API key and does not depend on that source.

## License of HIVE core

HIVE core (`src/`, `bin/`, `desktop/`, `docs/`) is **MIT** (see `LICENSE`).

## Removed sibling folders (archived, recoverable)

Moved to `C:\_hive_archive_2026-08-16\`:
- `hive-cloud/` (was a separate git repo)
- `the-hive-skill/` (was a separate git repo)
- `HiveMind/` and `C:\c\HiveMind\` (duplicates of the-hive-skill)
- `C:\tmp\the-hive-skill\` and `C:\backups\the-hive-skill\` (temp/backup copies)

To permanently reclaim space, delete `C:\_hive_archive_2026-08-16\` once you have
verified the consolidated repo contains everything you need.
