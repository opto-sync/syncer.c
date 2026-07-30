<<<<<<< HEAD
# Known git-submodule consumers

Last audited: 2026-07-27.

The following repositories pin `syncer.c` and `opto-sync-clients` as Git
submodules. They are downstream release consumers, not examples: an ABI,
package-layout, or client-path change must be tested against them before a
release is tagged.

| Repository | Engine path | Clients path |
=======
# Git submodule consumers

Last audited: 2026-07-27.

The following repositories pin both `syncer.c` and `opto-sync-clients` as Git
submodules. These are release consumers, not illustrative examples: changes to
the ABI, package layout, repository names, or sibling-path contract must be
validated against them before tagging a release.

| Repository | Engine path | Client path |
>>>>>>> origin/agent/zed-release-hardening-20260727
|---|---|---|
| `sonus-auris/sonus-auris-sync` | `third_party/syncer.c` | `third_party/opto-sync-clients` |
| `voxletra/voxletra-sync` | `vendor/syncer.c` | `vendor/opto-sync-clients` |

<<<<<<< HEAD
Both consumers deliberately keep the two repositories as siblings because the
client native manifests currently reach the engine through relative path
dependencies. Changing either repository name, checkout depth, or relative
layout is therefore a cross-repository migration.

## Release checklist

For any change that affects public headers, binding layout, client path
dependencies, merge semantics, or the Zed artifact:

1. Run the core and binding suites in this repository.
2. Run `opto-sync-e2e`, including client-in-the-loop and cross-server tests.
3. Open downstream pull requests that bump **both** gitlinks to compatible
   revisions when the two repositories changed together.
4. Initialize submodules in a clean clone and run each downstream repository's
   sync tests; do not validate against an uncommitted sibling checkout.
5. Merge downstream bumps only after upstream CI is green and the exact commits
   are immutable.

## Audit method

The inventory was built from GitHub commit search for `opto-sync`/`submodule`
and then confirmed against each repository's committed `.gitmodules` file.
Commit-message references alone are not treated as proof. Add newly discovered
consumers to this table in the same pull request that adopts the gitlink.
=======
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
>>>>>>> origin/agent/zed-release-hardening-20260727
