# Git submodule consumers

Last audited: 2026-07-27.

The following repositories pin both `syncer.c` and `opto-sync-clients` as Git
submodules. These are release consumers, not illustrative examples: changes to
the ABI, package layout, repository names, or sibling-path contract must be
validated against them before tagging a release.

| Repository | Engine path | Client path |
|---|---|---|
| `sonus-auris/sonus-auris-sync` | `third_party/syncer.c` | `third_party/opto-sync-clients` |
| `voxletra/voxletra-sync` | `vendor/syncer.c` | `vendor/opto-sync-clients` |

The inventory was built from GitHub commit search for opto-sync submodule
adoption and then confirmed against each repository's committed `.gitmodules`
file. Commit messages alone are not treated as proof.

## Why both gitlinks move together

The client manifests currently resolve the native engine through relative paths
to a sibling checkout named `syncer.c`. Moving only one gitlink can therefore
produce a clean Git state that cannot build, or can pair client semantics with an
incompatible core ABI.

## Coordinated release checklist

For changes affecting public headers, native bindings, package layout, merge
semantics, or Zed artifacts:

1. Run the core, sanitizer, binding, SQL/plugin, and differential suites.
2. Run `opto-sync-e2e`, including client-in-the-loop and cross-server tests.
3. Open downstream pull requests that bump both gitlinks to the certified pair.
4. Initialize submodules in a clean clone and run each downstream sync suite.
5. Merge downstream bumps only after upstream CI is green and the referenced
   commits are immutable.

Add newly confirmed consumers to this file in the same pull request that adopts
the gitlink or changes the sibling-path contract.
