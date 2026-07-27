# Zed package layout

`syncer.c` is a source-of-truth repository for one C reconciliation engine and
multiple language bindings. It is packaged for [zed-pkg](https://zpkg.tech) from
the root `.zpkg.toml`.

## Package identities

| Zed package | Source | Intended use |
|---|---|---|
| `opto-sync/syncer` | whole repository | canonical package for native bindings, SQL extensions, ORM plugins, and cross-language development |
| `opto-sync/syncer-c` | `core/` | self-contained C99 library with headers, CMake, vendored yyjson, and license text |
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

## Validation

The `Zed package contract` GitHub Actions workflow builds pinned revisions of
`zed-cli` and `zed-interfaces`, runs the complete pack/publish dry-run fan-out,
and asserts the three expected identities. It then extracts the generated
archives into clean directories and exercises them as consumers:

- the whole-repository and C-only artifacts are compiled with a fresh C program,
  which checks `syncer_version()` and performs a real merge;
- the WASM artifact is imported from the extracted package, initialized in Node,
  version-checked, and used for a real merge; and
- every archive must contain `pkg/LICENSE`, while derived target manifests are
  rejected if they retain source-tree-only commands.

Only after those checks pass are the deterministic archives uploaded for
inspection. The empty `.zpkg.lock` is intentional: this source repository has no
Zed-managed dependencies yet.

Downstream repositories that pin the engine and clients as gitlinks are recorded
in [SUBMODULE_CONSUMERS.md](SUBMODULE_CONSUMERS.md). Review that inventory before
changing public headers, binding paths, or package layout.

## Registry publication

`.github/workflows/zed-publish.yml` is the only automated registry-write path:

- pull requests run a non-mutating `zed publish --dry-run`;
- the checkout includes full tag history but does not persist GitHub credentials;
- a branch run is rejected—publication requires a selected or pushed `v*` tag;
- `zed publish` independently verifies that the manifest's tag points at the
  checked-out commit; and
- the registry credential comes only from the repository secret
  `ZED_PKG_TOKEN`.

Before the first release, claim or authorize the `opto-sync` namespace in the
Zed registry and provision `ZED_PKG_TOKEN` for this repository. Then create
`v0.2.1` on the reviewed `main` commit. A successful tag workflow publishes all
three immutable artifacts; package-ready source and a green dry run alone do not
prove that registry entries already exist.

Manual preflight remains useful:

```sh
cd core && make && make sanitize
cd ..
zed pack
zed publish --dry-run
```
