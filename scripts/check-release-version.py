#!/usr/bin/env python3
"""Fail when the core, Zed package, or first-party bindings drift in version."""

from __future__ import annotations

import json
import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read_toml(path: str) -> dict:
    with (ROOT / path).open("rb") as handle:
        return tomllib.load(handle)


def toml_version(path: str) -> str:
    data = read_toml(path)
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
    manifest = read_toml(".zpkg.toml")
    expected = str(manifest["package"]["version"])

    targets = manifest.get("targets", {})
    expected_targets = {
        "repository": (".", "syncer"),
        "c": ("core", "syncer-c"),
        "wasm": ("bindings/wasm", "syncer-wasm"),
    }
    actual_targets = {
        name: (str(value.get("dir")), str(value.get("name")))
        for name, value in targets.items()
    }
    if actual_targets != expected_targets:
        print(
            f"unexpected Zed target fan-out: {actual_targets!r}; expected {expected_targets!r}",
            file=sys.stderr,
        )
        return 1

    lock = read_toml(".zpkg.lock")
    if lock.get("version") != 1:
        print(".zpkg.lock must declare format version 1", file=sys.stderr)
        return 1

    if not (ROOT / "LICENSE").is_file():
        print("root LICENSE is required for an MIT package", file=sys.stderr)
        return 1

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

    print(f"\nall release surfaces and Zed targets agree on {expected}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
