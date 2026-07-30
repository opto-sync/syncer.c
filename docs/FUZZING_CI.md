# Fuzzing in CI

The deterministic unit, property, binding, plugin, SQL, and differential suites
remain the primary pull-request gates. `.github/workflows/fuzz-canary.yml` adds
coverage-guided campaigns for malformed and adversarial inputs that fixed test
vectors cannot enumerate.

## Pull requests

Changes to `core/**`, the release-version ratchet, or the workflow run every
fuzzer for 20 seconds and then replay the grown corpus under a dedicated
ASan+LeakSanitizer build. This is intentionally short enough to remain a normal
review gate while still compiling and exercising every harness:

- `fuzz_merge`
- `fuzz_strategies`
- `fuzz_callback`
- `fuzz_idempotent`

## Nightly campaign

The scheduled run uses two libFuzzer workers, a 16 KiB maximum input, and five
minutes per harness for both the ASan+UBSan campaign and the leak-focused pass.
Nightly runs are not cancelled by another scheduled run. Pull-request runs are
cancelled when superseded.

The Linux Clang container is pinned to the major-version tag `silkeh/clang:18`
rather than following `latest`. The repository is mounted read-only except for
the existing crash-artifact directory used by the runner.

## Failures

Any crash, undefined behavior report, timeout, or leak makes the job fail. The
workflow uploads `core/test/fuzz/crashes/` for 30 days. Reproduce an artifact
locally with:

```sh
bash core/test/fuzz/run_fuzz.sh repro core/test/fuzz/crashes/<artifact>
```

Do not commit a crash artifact until it has been minimized and paired with a
fixed regression test or a documented decision that the input is outside the
public contract.
