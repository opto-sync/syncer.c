# Zed package contract

`syncer.c` is published as the whole-repository Zed source package:

```text
opto-sync/syncer-c@0.2.1
```

The package identity and release version live in the repository-root
[`.zpkg.toml`](../.zpkg.toml); [`.zpkg.lock`](../.zpkg.lock) is checked in even
when this source repository has no Zed-managed dependencies, so CI and future
consumers can use the same frozen-install contract.

## Why this is one whole-repository package

Every first-party binding uses the same C implementation under `core/`:
TypeScript and WebAssembly embed it, Rust and Go compile it, Dart loads its
shared library, and the BEAM/Gleam layer reaches it through the Rustler NIF.
Publishing isolated language targets today would omit that shared source from
each target artifact and create packages that look valid but cannot build.

The correct initial unit is therefore the complete source tree. Language-only
packages can be added later only when their artifacts either include the shared
core explicitly or depend on a separately installed `syncer-c` source package
through a tested native-toolchain path.

## Package boundary

The artifact includes the C core, all maintained bindings and adapters,
documentation, the root license, manifest, and lockfile. It excludes VCS/CI
metadata, dependency directories, compiler output, language caches, fuzz logs,
and generated differential-test state.

No Zed `[build]` hook is declared. Installing the source package never executes
package-author code automatically; consumers opt into the native build command
appropriate for their runtime.

## Release preflight

From a clean checkout:

```sh
python3 scripts/check-release-version.py
make -C core
zed pack
zed publish --dry-run
```

Before the real publish, create the immutable provenance tag declared by
`publish.tag_format` and make sure it points at the release commit:

```sh
git tag v0.2.1
git push origin v0.2.1
zed publish
```

The `Zed package` GitHub Actions workflow builds `zed-cli` and
`zed-interfaces` from pinned commits, runs the native core suite, packs twice,
requires byte-for-byte identical archives, and inspects the resulting file
boundary. Updating either pinned Zed revision is a reviewed supply-chain change,
not an implicit move to another `main` revision.
