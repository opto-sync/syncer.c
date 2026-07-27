# Zed package contract

`syncer.c` is published to Zed as the whole-repository source package
`opto-sync/syncer`. The artifact intentionally contains the C engine and every
language binding together: the bindings share the same ABI-sensitive core and
several of them compile it from source at consumer build time.

The authoritative files are at the repository root:

- `.zpkg.toml` — package identity, version, repository provenance, exclusions,
  and the installed-artifact smoke test.
- `.zpkg.lock` — Zed lockfile format version. It currently has no `[[package]]`
  entries because the engine has no Zed-sourced dependencies.

## Release procedure

1. Keep `package.version` aligned with `syncer_version()` and the first-party
   binding versions.
2. Run the normal core, sanitizer, binding, differential, SQL, and ORM suites.
3. Run `zed r2g`. This packs the exact pruned artifact, publishes it to a
   throwaway `file://` registry, installs it into a clean consumer, and executes
   `scripts/zpkg-smoke.sh` against the installed copy.
4. Review the packed file list. Generated build trees, package-manager caches,
   and `.zed/` output must not be present.
5. Create the matching `v{version}` Git tag at the exact commit being published.
6. Publish with `zed publish`.

The GitHub Actions workflow `.github/workflows/zpkg.yml` builds the current Zed
CLI and `zed-interfaces` from source as sibling repositories, then runs the same
roundtrip on every relevant pull request and push to `main`.

## Why the client repository is not yet split into Zed language targets

`opto-sync-clients` is a polyglot repository, but each native package currently
has a source-layout path dependency on a sibling checkout named `syncer.c`:

- TypeScript: `file:../../../syncer.c/bindings/{typescript,wasm}`
- Dart: `../../../syncer.c/bindings/dart`
- Rust: `../../../syncer.c/bindings/rust`
- Gleam: `../../../syncer.c/bindings/gleam`

A Zed language target contains only its declared subtree. Publishing those four
subtrees today would therefore create artifacts whose native manifests point to
files that are not inside the artifact. A manifest that merely *packs* is not a
valid package.

The dependency-ordered follow-up is to make the binding dependency relocatable
without breaking current git-submodule consumers, then publish isolated
`nodejs`, `dart`, `rust`, and `gleam` targets from a single root manifest. Until
that migration is complete, `opto-sync/syncer` is the valid Zed package and the
clients remain distributed through their native manifests and pinned git
checkouts.
