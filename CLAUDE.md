# Claude Code Guidelines for kestl

## Versioning — DO NOT manually edit version numbers

Version numbers are managed automatically by **release-please**. The single source of truth is:

```
src-tauri/tauri.conf.json  →  "version": "x.y.z"
```

`src-tauri/Cargo.toml` and the UI version display are kept in sync automatically:
- `Cargo.toml` is updated by release-please alongside `tauri.conf.json`
- The UI reads `__APP_VERSION__` injected by Vite at build time from `tauri.conf.json`

**Never manually edit version numbers in any file.** release-please reads commit messages to determine the bump and opens a PR to do it.

## Commit messages — always use Conventional Commits

Every commit must follow the [Conventional Commits](https://www.conventionalcommits.org/) format:

```
<type>[optional scope]: <description>

[optional body]
```

| Prefix | Effect | Example |
|--------|--------|---------|
| `fix:` | patch bump (1.2.x) | `fix: duplicate detection for pending transactions` |
| `feat:` | minor bump (1.x.0) | `feat: add parser rename in settings` |
| `feat!:` or `BREAKING CHANGE:` | major bump (x.0.0) | `feat!: new data format` |
| `chore:`, `docs:`, `refactor:`, `test:` | no bump | `chore: update dependencies` |

release-please reads these prefixes to build the CHANGELOG and decide the version bump.

## Release flow

1. Commits land on `main` → release-please action runs
2. release-please opens/updates a "Release PR" that bumps versions and updates `CHANGELOG.md`
3. When you merge the Release PR → release-please creates a `v*` tag
4. The `v*` tag triggers the **release.yml** workflow which builds the Tauri app for Windows + Linux and publishes a GitHub Release with installers attached
