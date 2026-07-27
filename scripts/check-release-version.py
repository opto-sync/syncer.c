#!/usr/bin/env python3
"""Fail when the native core, Zed package, or first-party bindings drift in version."""

from __future__ import annotations

import json
import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def toml_version(path: str) -> str:
    data = tomllib.loads((ROOT / path).read_text(encoding="utf-8"))
    if path == ".zpkg.toml":
        return str(data["package"]["version"])
    if path.endswith("Cargo.toml"):
        return str(data["package"]["version"])
    return str(data["version"])


def json_version(path: str) -> str:
    return str(json.loads((ROOT / path).read_text(encoding="utf-8"))["version"])


def regex_version(path: str, pattern: str, label: str) -> str:
    text = (ROOT / path).read_text(encoding="utf-8")
    match = re.search(pattern, text, re.MULTILINE)
    if not match:
        raise RuntimeError(f"could not find {label} version in {path}")
    return match.group(1)


def main() -> int:
    expected = toml_version(".zpkg.toml")
    versions = {
        ".zpkg.toml": expected,
        "core/src/syncer.c": regex_version(
            "core/src/syncer.c",
            r'const char\*\s+syncer_version\s*\(void\)\s*\{\s*return\s+"([^"]+)";',
            "C core",
        ),
        "bindings/typescript/package.json": json_version("bindings/typescript/package.json"),
        "bindings/wasm/package.json": json_version("bindings/wasm/package.json"),
        "bindings/rust/Cargo.toml": toml_version("bindings/rust/Cargo.toml"),
        "bindings/dart/pubspec.yaml": regex_version(
            "bindings/dart/pubspec.yaml", r"^version:\s*['\"]?([^'\"\s]+)", "Dart"
        ),
        "bindings/gleam/gleam.toml": toml_version("bindings/gleam/gleam.toml"),
        "bindings/beam/mix.exs": regex_version(
            "bindings/beam/mix.exs", r'^\s*@version\s+"([^"]+)"', "BEAM"
        ),
        "README.md": regex_version(
            "README.md", r"Core is \*\*([^*]+)\*\*", "README status"
        ),
    }

    mismatches = {path: version for path, version in versions.items() if version != expected}
    for path, version in versions.items():
        print(f"{path}: {version}")

    if mismatches:
        print(f"\nrelease version must be {expected}; mismatches:", file=sys.stderr)
        for path, version in mismatches.items():
            print(f"  {path}: {version}", file=sys.stderr)
        return 1

    print(f"\nall release surfaces agree on {expected}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
