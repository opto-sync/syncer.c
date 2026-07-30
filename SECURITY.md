# Security policy

## Supported versions

Security fixes are made on `main` and released in the newest tagged version.
Older tags should be upgraded before a report is considered resolved.

## Reporting a vulnerability

Use GitHub's private **Report a vulnerability** / Security Advisory flow for
this repository. Do not open a public issue containing exploit code, private
data, credentials, unpublished package URLs, or details that make an unpatched
vulnerability easier to abuse.

Include, when applicable:

- the affected version or commit and binding/runtime;
- the smallest safe reproduction and expected versus actual behavior;
- compiler, architecture, operating system, and sanitizer output;
- whether untrusted JSON can trigger the issue remotely;
- whether the issue crosses an FFI, WASM, SQL-extension, ORM, or package boundary;
- crash traces without secrets or customer documents; and
- a proposed mitigation that preserves merge determinism and ABI compatibility.

The following classes are security-sensitive even when they first look like
ordinary correctness defects:

- memory corruption, out-of-bounds access, use-after-free, integer overflow, or
  lifetime mistakes in the C core or native bindings;
- malformed-input crashes, pathological CPU/memory consumption, stack
  exhaustion, or parser differentials;
- FFI ownership bugs that double-free, leak, or expose data across runtimes;
- SQL-extension or ORM behavior that bypasses expected database authorization;
- reconciliation divergence that can silently discard or resurrect protected
  data;
- WASM/browser boundary escapes or unexpected network/filesystem access; and
- artifact substitution, missing provenance/license material, or dependency
  confusion in the Zed and ecosystem packages.

## Coordinated disclosure

Maintainers will acknowledge a usable private report, reproduce it against the
supported branch, assess affected packages and downstream gitlink consumers,
and coordinate a fix and disclosure date. Please avoid public technical detail
until a patched release or mutually agreed disclosure date exists.
