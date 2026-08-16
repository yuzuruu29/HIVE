# NOTICE — Vendored Code & Consolidation

This repository (`C:\HIVE`) is the consolidated home for the HIVE project. The
following related projects were merged into it on 2026-08-16. Their original
folders were moved (not permanently deleted) to `C:\_hive_archive_2026-08-16\`
as a reversible backup.

## Vendored into this repo

| Path | Source project | Upstream license | Notes |
|------|----------------|------------------|-------|
| `skills/hive-mind-council/` | `the-hive-skill` | Apache-2.0 | The built-in **hive skill** (six-role council protocol). |
| `hive-cloud/` | `hive-cloud` | AGPL-3.0 | HIVE Cloud web workspace source, kept as a reference companion. **AGPL-3.0 is a strong copyleft license**; if you distribute `hive-cloud/` as part of a product, comply with AGPL obligations or keep it separate. |

## License of HIVE core

HIVE core (`src/`, `bin/`, `desktop/`, `docs/` excluding `hive-cloud/`) remains
**MIT** (see `LICENSE`). The vendored `hive-cloud/` directory retains its own
`LICENSE.md` (AGPL-3.0) and is conceptually a separate component.

## Removed sibling folders (archived, recoverable)

Moved to `C:\_hive_archive_2026-08-16\`:
- `hive-cloud/` (was a separate git repo)
- `the-hive-skill/` (was a separate git repo)
- `HiveMind/` and `C:\c\HiveMind\` (duplicates of the-hive-skill)
- `C:\tmp\the-hive-skill\` and `C:\backups\the-hive-skill\` (temp/backup copies)

To permanently reclaim space, delete `C:\_hive_archive_2026-08-16\` once you have
verified the consolidated repo contains everything you need.
