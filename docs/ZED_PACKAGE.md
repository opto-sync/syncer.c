# Zed package layout

`syncer.c` is a source-of-truth repository for one C reconciliation engine and
multiple language bindings. It is packaged for [zed-pkg](https://zpkg.tech) from
the root `.zpkg.toml`.

## Published artifacts

| Zed package | Source | Intended use |
|---|---|---|
| `opto-sync/syncer` | whole repository | canonical package for native bindings, SQL extensions, ORM plugins, and cross-language development |
| `opto-sync/syncer-c` | `core/` | self-contained C99 library with headers, CMake, and vendored yyjson |
| `opto-sync/syncer-wasm` | `bindings/wasm/` | self-contained committed WebAssembly distribution for browsers, workers, and Node |

All three artifacts share version `0.2.1` and one verified Git tag,
`v0.2.1`. The root package name (`syncer-packages`) is only the fan-out source;
consumers install one of the names above.

## Why the other language directories are not targets yet

The native TypeScript, Rust, Go, Dart, BEAM, and Gleam bindings compile or load
files from `core/` or another sibling binding using paths above their own package
directory. A language-only archive would therefore contain a native manifest
whose path dependency points outside the installed artifact. That is a broken
package even when `zed pack` can create the tarball.

Until those bindings embed the required C sources or declare independently
installable Zed dependencies, consume them through `opto-sync/syncer`. Add a new
`[targets.<language>]` entry only after a clean-room consumer can build the
isolated target with no checkout of this repository beside it.

## Release preflight

```sh
cd core && make && make sanitize
zed pack
zed publish --dry-run
# after the matching v0.2.1 tag points at HEAD and registry auth is configured:
zed publish
```

The `Zed package contract` GitHub Actions workflow builds pinned revisions of
`zed-cli` and `zed-interfaces`, runs the complete pack/publish dry-run fan-out,
and asserts the three expected identities. It then extracts the generated
archives into clean directories and exercises them as consumers:

- the whole-repository and C-only artifacts are compiled with a fresh C program,
  which checks `syncer_version()` and performs a real merge;
- the WASM artifact is imported from the extracted package, initialized in Node,
  version-checked, and used for a real merge.

Only after those checks pass are the deterministic archives uploaded for
inspection. The empty `.zpkg.lock` is intentional: this source repository has no
Zed-managed dependencies yet.

Downstream repositories that pin the engine and clients as gitlinks are recorded
in [SUBMODULE_CONSUMERS.md](SUBMODULE_CONSUMERS.md). Review that inventory before
changing public headers, binding paths, or package layout.
