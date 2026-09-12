# Opto-Sync organization agent instructions

<!-- ore-org-baseline:begin -->
These instructions apply to this repository. Repository-local instructions may add stricter requirements, but they must not weaken this baseline.

## Canonical organization links

- GitHub organization: https://github.com/opto-sync
- Public organization defaults: https://github.com/opto-sync/.github
- Canonical Linear project: https://linear.app/denman/project/githubcomopto-sync-de6ba65bd559
- Fleet tracking issue: https://github.com/ORESoftware/k8s-cluster/issues/1222

## Instruction discovery

Lowercase `agents.md` is canonical. Read every applicable lowercase `agents.md` from the repository root toward the current working directory before editing. Uppercase `AGENTS.md` and provider-specific instruction files are compatibility mirrors and must remain aligned with the applicable lowercase policy.

The canonical organization-wide file is
[opto-sync/.github/agents.md](https://github.com/opto-sync/.github/blob/main/agents.md).
Keep [opto-sync/.github/AGENTS.md](https://github.com/opto-sync/.github/blob/main/AGENTS.md)
and [opto-sync/syncer.c/AGENTS.md](https://github.com/opto-sync/syncer.c/blob/main/AGENTS.md)
byte-for-byte identical to it. In a repository that has only an uppercase
`AGENTS.md`, read that compatibility mirror. Update all three files in the
same coordinated change, and compare their contents before merging. Preserve
organization governance and repository-local instructions when updating a mirror.

## Inspect before editing

Inspect the current branch, complete working tree, remotes, default branch, open pull requests, linked GitHub issues, linked Linear work, repository documentation, tests, schemas, generated artifacts, deployment definitions, and relevant related repositories. Preserve every unfamiliar or uncommitted change.

Use read-only inspection and non-pruning synchronization such as `git status --short --branch`, `git remote -v`, `git fetch --all`, `git diff`, `git log`, `git show`, and `git blame`. Never treat a dirty worktree or inconvenient branch as permission to discard state.

## Mandatory semantic conflict resolution

> resolve any and all git conflicts semantically, will full context, even looking back 3-10 commits in git log history for more context - never hastily pick sides in a conflict but merge things conceptually, using max context and complete conceptual awareness for a given github organization's repos and external org repos too

For every conflict:

1. Read the merge base, both complete sides, surrounding implementation, tests, schemas, generated artifacts, documentation, deployment configuration, and public contracts—not only conflict markers.
2. Inspect the affected path history and normally review 3–10 relevant commits on each side with `git log`, `git show`, and `git blame` where useful.
3. Review linked pull requests, issues, Linear work, related repositories in `opto-sync`, and relevant external-organization repositories whenever behavior or contracts cross boundaries.
4. Preserve compatible intent and invariants from both sides. Synthesize a conceptual merge; never resolve by selecting `ours`, `theirs`, `current`, or `incoming` wholesale.
5. Scan the complete tree for unresolved markers and run the applicable formatter, linter, unit, integration, contract, build, security, and end-to-end checks.
6. Document incompatible requirements, intentional choices, and any discarded intent in the commit and pull-request description.

## Hard denylist for automated agents

Automated agents must **never execute or recommend** destructive, state-concealing, history-rewriting, purge, revocation, or policy-bypass operations. This is a hard denylist: authorization may support a reviewed human-run procedure, but it does not authorize an automated agent to perform the destructive step.

The blacklist includes, without limitation:

- every form of `git stash`, every mode of `git reset`, every mode of `git clean`, `git filter-repo`, `git filter-branch`, BFG, `git rebase`, interactive history rewriting, `git commit --amend`, commit replacement, destructive `git checkout -- <path>`, destructive `git restore`, `git branch -D`, ref or tag deletion, `git reflog expire`, `git gc --prune`, `git push --force`, and `git push --force-with-lease`;
- recursive or bulk deletion and destructive filesystem mutation, including `rm -rf`, `find -delete`, truncation, shredding, destructive overwrite, formatting, and access-removing ownership or permission changes;
- destructive data operations, including `DROP`, `TRUNCATE`, unbounded `DELETE`, destructive rollback, irreversible migration, bucket/object purge, queue/topic deletion, and bulk mutation without a bounded reversible plan;
- destructive infrastructure or identity operations, including `kubectl delete`, `helm uninstall`, `terraform destroy`, `pulumi destroy`, cloud delete/purge calls, cluster or namespace teardown, and autonomous secret, key, certificate, credential, factor, or session revocation or rotation;
- deleting repositories, worktrees, submodules, branches, tags, releases, packages, artifacts, registries, environments, evidence, audit logs, customer data, or production state;
- bypassing hooks, reviews, branch protection, rulesets, required checks, security/compliance gates, approvals, or audit logging, including `--no-verify` and equivalent bypasses.

Do not use destructive commands merely to make tests pass, clear a conflict, simplify a migration, or hide an inconvenient state.

### Required safe alternatives

Use additive branches, separate clean worktrees or clones, explicit path staging, ordinary commits, non-force pushes, patch-based edits, read-only queries, dry runs, backups, additive migrations, and reversible roll-forward changes. For integration, avoid git rebase in favor of git merge. Leave unrelated work untouched. When safe progress is impossible, preserve all state and report the exact blocker.

## Source ownership and cross-repository context

Edit authoritative sources rather than generated mirrors, vendored copies, caches, or downstream consumers. Identify generators and regenerate derived artifacts from reviewed sources. Never detach, absorb, relocate, remove, or rewrite a submodule or worktree. Cross-repository behavior must be understood across the owning organization and relevant external organizations before contracts are changed.

## Secrets and sensitive data

Never print, log, commit, paste into issues, include in fixtures, or expose tokens, passwords, private keys, session material, database URLs, customer data, legal records, private health data, production data, or unpublished security details. Use approved secret stores, placeholders, and redacted diagnostics.

## Pull requests, validation, and evidence

Use focused branches and pull requests. Link the relevant Linear issue or project. Explain behavior, risks, migration and roll-forward considerations, security impact, tests run, conflicts and their semantic resolution, and cross-repository dependencies. Never report a branch, commit, pull request, merge, deployment, test run, or external update as complete without authoritative remote evidence.
<!-- ore-org-baseline:end -->

<!-- ore-primary-branch-policy:begin -->
## Primary branch and concurrent-agent policy

This organization policy overrides generic feature-branch and worktree defaults for agent tooling.

- Highly prefer an existing primary branch, in this order: `main`, `dev`, then `master`.
- Work directly on the selected primary branch even when other agents are active. Use another branch only when a human or a repository-specific release process explicitly requires it.
- Never create or use a Git worktree unless a human explicitly instructs you to do so for the current task. Concurrency alone is not permission to use a worktree.
- Concurrent agents must coordinate repository and file ownership through the available agent communication channel, keep edits scoped, inspect live state before each write, and hand off cleanly. Coordinate instead of isolating routine work in worktrees.
- Preserve unrelated in-progress changes and never overwrite another agent's work. If safe ownership of overlapping files cannot be established, pause that overlapping edit and coordinate before continuing.
<!-- ore-primary-branch-policy:end -->

## Repository-local Git worktrees

- Create or use a Git worktree only when the human operator explicitly authorizes it for the current task. Concurrency or a dirty checkout is not permission by itself.
- Put every authorized worktree at `<repository-root>/tmp/worktrees/<name>`; from the repository root, use `./tmp/worktrees/<name>`. Never place worktrees beside repositories or organization directories.
- Keep `tmp`, `temp`, `tmp/worktrees`, and `temp/worktrees` ignored in the repository-root `.gitignore`. Do not commit files from those directories.
- Relocate or remove a worktree only when the operator explicitly requests it. Before removal, preserve and publish intended changes, verify its commit is represented on the target branch, and confirm there are no tracked, untracked, ignored-sensitive, or in-use files that must survive. Remove it with `git worktree remove <path>` without `--force`; never delete a worktree directory with `rm`.

## Opto-Sync packages, dependencies, and consumers

[Opto-Sync](https://github.com/opto-sync) is distributed through
[Zed](https://github.com/zed-pkg) as an SDK/library used by other codebases.
Changes to any Opto-Sync repository must account for the consumers of its
engines, language bindings, shared contracts, and client libraries.

### Versioning and compatibility

Breaking changes are allowed when their impact is understood and the release
version and migration instructions communicate that impact. Use these
Opto-Sync project versioning rules:

- **Major version bump:** large breaking changes to APIs, ABIs, wire contracts,
  persisted data, or synchronization behavior.
- **Minor version bump:** small, bounded breaking changes with an explicit
  migration path; also use a minor bump for compatible feature additions.
- **Patch version bump:** non-breaking fixes, minute changes, and compatible
  maintenance work.

These are the project's versioning conventions. Every breaking change,
including a minor release, must be labeled in the release notes so consumers
can assess compatibility before upgrading. Documentation-only changes do not
require publishing a new SDK version.

Before releasing an Opto-Sync change:

- Identify affected downstream wrappers and the upstream Opto-Sync packages
  they use. Check their actual Zed manifests, lockfiles, Git revisions, and
  language-specific dependency declarations rather than assuming every
  consumer depends directly on `syncer.c`.
- Keep the released package version, published artifacts, bindings, and
  release notes consistent. Record the old and new behavior and any API,
  wire-format, persisted-data, or conflict-resolution migration.
- Run the applicable engine, binding, contract, and downstream integration
  checks. Record which consumers were exercised and any remaining coverage
  gaps in the release PR.
- Coordinate affected wrapper upgrades and dependency-pin changes, and
  describe compatibility with older clients during a rolling upgrade.

### Consumer organizations and wrapper repositories

These organizations have product wrappers or documented integrations over
Opto-Sync. Keep the list organized alphabetically by organization and review
it when evaluating the impact of a release.

- **3fa-app:** [3fa-app/3fa-app-sync](https://github.com/3fa-app/3fa-app-sync).
- **agent-pontifex:** [agent-pontifex/agent-pontifex-sync](https://github.com/agent-pontifex/agent-pontifex-sync).
- **apostille-me:** [apostille-me/apme-sync](https://github.com/apostille-me/apme-sync).
- **athlet-o:** [athlet-o/athleto-sync](https://github.com/athlet-o/athleto-sync).
- **daedalus-fab:** [daedalus-fab/daedalus-sync](https://github.com/daedalus-fab/daedalus-sync).
- **declarative-migrations:** [declarative-migrations/declmig-sync](https://github.com/declarative-migrations/declmig-sync).
- **embedded-alerts:** [embedded-alerts/eal-sync](https://github.com/embedded-alerts/eal-sync).
- **evento-globolo:** [evento-globolo/evgl-sync](https://github.com/evento-globolo/evgl-sync).
- **fiducia-cloud:** [fiducia-cloud/fiducia-sync](https://github.com/fiducia-cloud/fiducia-sync).
- **file-tunnel:** [file-tunnel/ftnl-sync](https://github.com/file-tunnel/ftnl-sync).
- **flags-2-env:** [flags-2-env/flags-2-env-sync](https://github.com/flags-2-env/flags-2-env-sync).
- **hacker-house-medellin:** [hacker-house-medellin/hhm-sync](https://github.com/hacker-house-medellin/hhm-sync).
- **happy-wakey:** [happy-wakey/happy-wakey-sync](https://github.com/happy-wakey/happy-wakey-sync).
- **ores-otel:** [ores-otel/ores-otel-sync](https://github.com/ores-otel/ores-otel-sync).
- **quaestor-ledger:** [quaestor-ledger/quaestor-sync](https://github.com/quaestor-ledger/quaestor-sync).
- **sonus-auris:** [sonus-auris/sonus-auris-sync](https://github.com/sonus-auris/sonus-auris-sync).
- **zed-pkg:** [zed-pkg/zed-sync](https://github.com/zed-pkg/zed-sync).

**Zed needs particular attention:** `zed-pkg` provides the package manager
that distributes Opto-Sync, while `zed-pkg/zed-sync` consumes Opto-Sync.
Review both directions of this relationship for package-format, dependency
resolution, bootstrap/install, publication, and synchronization changes.
Avoid creating a bootstrap dependency cycle, and validate that a clean Zed
installation can still install the intended Opto-Sync package versions.
