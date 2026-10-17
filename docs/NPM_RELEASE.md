# npm CLI package

HIVE's npm package is `@uzzy-malolos/hive`; its executable is `hive`. This is
separate from the Windows desktop installer and the unrelated unscoped npm
package named `hive`. `hive@uzzy-malolos` selects a distribution tag of that other
package, not this project.

Preparing or testing a package does **not** publish it. Until a public version
exists, install an inspected local tarball rather than expecting the registry
command to work.

## Requirements and installation

- Node.js 22.17 or newer and npm.
- Git for repository inspection and managed coding worktrees.
- Your own provider API credential, a running local model, or a supported
  subscription sign-in for generation. No models or provider credits are bundled.
- Codex must already be installed if using the optional ChatGPT subscription route.

After publication, install the global CLI with:

```sh
npm install -g @uzzy-malolos/hive
hive --help
hive providers setup
```

Run `hive` inside the repository you want to work on. A local dependency install
also works; use `npm exec -- hive --help` from that consumer project instead of
expecting a local install to add `hive` to your system PATH.

## Build and inspect without publishing

From the source checkout:

```sh
npm ci
npm run lint
npm test
npm run test:package
npm pack --dry-run
npm pack
```

`prepack` runs `npm run build` before `npm pack` and `npm publish`, so a clean
checkout does not depend on a developer's existing `dist` directory. Development
dependencies are required to build a release; registry consumers receive compiled
JavaScript and do not need TypeScript, Electron, or build/install hooks.

The top-level `files` allowlist includes the CLI launcher, compiled runtime and
types, built-in council prompts/references, their Apache-2.0 license, HIVE's MIT
license/notice, and CLI documentation. Source, tests, development settings,
credentials, local session state, desktop/web renderer sources, and desktop
installers are not part of the npm package. `build.files` is a separate Electron
setting, not an npm allowlist.

At version 0.6.0, the generated archive can be installed into your npm global
prefix for a manual check:

```sh
npm install -g ./uzzy-malolos-hive-0.6.0.tgz
hive --help
hive providers presets --json
```

That manual command changes your global installation. Prefer `npm run test:package`
for an isolated check that leaves your actual global prefix and HIVE configuration
alone. Use the actual archive filename printed by `npm pack` after a version bump.

## Automated artifact verification

`npm run test:package` stages source without compiled output, runs real pack
lifecycle hooks, verifies archive contents, installs only the local archive into a
temporary global prefix with production dependencies, and exercises the installed
CLI and command shim. It also checks library imports and bundled skill lookup from
an unrelated working directory, and rejects development/private files or a
consumer dependency on TypeScript/Electron. Temporary files are removed afterward.

The test installs runtime dependencies from the configured npm registry and needs
network access or a populated npm cache. It does not contact model providers,
request inference, publish packages, or require npm publishing credentials.

CI runs this artifact check on Ubuntu and Windows with Node.js 22.17, independently
of the source test suite. Interactive terminal behavior and live model access are
separate from the package startup checks.

## Publication checklist (maintainer action only)

1. Confirm that the npm account or organization controls the `uzzy-malolos` scope.
2. Choose the release version and keep `package.json` and `package-lock.json` in sync.
3. Run lint, the source tests, and the isolated package checks above; require the
   Windows and Ubuntu artifact jobs to pass.
4. Inspect `npm pack --dry-run` for unexpected files and verify the README and
   third-party license notices.
5. Sign in with an account authorized to publish the public scoped package, using
   npm's required authentication/2FA or an appropriately configured trusted
   publishing workflow. Never store tokens in this repository.
6. Preview the release with `npm publish --dry-run --access public`.
7. Only with explicit release approval, run `npm publish --access public`.
8. Verify the published version from an unrelated clean environment with
   `npm install -g @uzzy-malolos/hive@0.6.0` (substitute the actual release version),
   then run `hive --help` and provider setup.

`publishConfig` targets the public npm registry and public access. There is no
workflow that automatically publishes on push or tag creation. Passing local
checks does not establish scope ownership, npm account access, public availability,
or successful Linux CI execution before those actions actually occur.
