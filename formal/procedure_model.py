#!/usr/bin/env python3
"""Fast bounded specification and manifest gate for syncer.c formal proofs."""

from __future__ import annotations

import argparse
import itertools
import json
import sys
import tomllib
from pathlib import Path
from typing import Any, Iterable

VALID_STRATEGIES = frozenset(range(5))


def normalize_decimal(value: str) -> str:
    if not value or any(ch < "0" or ch > "9" for ch in value):
        raise ValueError("timestamp must be a non-empty decimal string")
    normalized = value.lstrip("0")
    return normalized or "0"


def compare_decimal(left: str, right: str) -> int:
    lhs = normalize_decimal(left)
    rhs = normalize_decimal(right)
    if len(lhs) != len(rhs):
        return -1 if len(lhs) < len(rhs) else 1
    return (lhs > rhs) - (lhs < rhs)


def strategy_valid(value: int) -> bool:
    return value in VALID_STRATEGIES


def load_manifest() -> dict[str, Any]:
    path = Path(__file__).with_name("fm.toml")
    with path.open("rb") as handle:
        manifest = tomllib.load(handle)
    assert manifest["schema_version"] == 1
    assert manifest["adapter_protocol"] == "json-stdin/v1"
    assert manifest["model"] == "formal/procedure_model.py"
    assert {entry["id"] for entry in manifest["invariants"]} == {
        "timestamp-total-order", "timestamp-antisymmetry", "timestamp-transitivity",
        "leading-zero-equivalence", "ffi-strategy-closed-world",
    }
    production = manifest["production_proofs"]
    repository_root = Path(__file__).resolve().parents[1]
    for key in ("cbmc", "script", "workflow"):
        assert (repository_root / production[key]).is_file(), production[key]
    assert (repository_root / production["kani"]).is_dir(), production["kani"]
    return manifest


def verify() -> dict[str, Any]:
    manifest = load_manifest()
    checks = 0
    for value in range(1000):
        canonical = str(value)
        for width in range(len(canonical), 7):
            padded = canonical.zfill(width)
            assert compare_decimal(canonical, padded) == 0
            assert compare_decimal(padded, canonical) == 0
            checks += 2

    two_digit = tuple(f"{value:02d}" for value in range(100))
    for left, right in itertools.product(two_digit, repeat=2):
        result = compare_decimal(left, right)
        expected = (int(left) > int(right)) - (int(left) < int(right))
        assert result == expected
        assert result == -compare_decimal(right, left)
        checks += 2

    representative = ("0", "00", "1", "01", "9", "09", "10", "010", "99", "099", "100", "999", "000999")
    for left, middle, right in itertools.product(representative, repeat=3):
        if compare_decimal(left, middle) <= 0 and compare_decimal(middle, right) <= 0:
            assert compare_decimal(left, right) <= 0
        checks += 1

    for candidate in range(-8, 13):
        assert strategy_valid(candidate) == (0 <= candidate <= 4)
        checks += 1

    return {
        "status": "ok", "model": manifest["id"], "claim": manifest["claim"],
        "checks": checks, "two_digit_pairs": len(two_digit) ** 2,
        "transitivity_triples": len(representative) ** 3,
    }


def emit(records: Iterable[dict[str, Any]]) -> None:
    for record in records:
        print(json.dumps(record, sort_keys=True, separators=(",", ":")))


def replay() -> None:
    load_manifest()
    outputs: list[dict[str, Any]] = []
    for line_number, raw in enumerate(sys.stdin, start=1):
        raw = raw.strip()
        if not raw:
            continue
        request = json.loads(raw)
        op = request.get("op")
        if op == "compare":
            result: Any = compare_decimal(str(request["left"]), str(request["right"]))
        elif op == "normalize":
            result = normalize_decimal(str(request["value"]))
        elif op == "strategy_valid":
            result = strategy_valid(int(request["value"]))
        else:
            raise ValueError(f"line {line_number}: unsupported op {op!r}")
        outputs.append({"schema_version": 1, "line": line_number, "op": op, "result": result})
    emit(outputs)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json-stdin", action="store_true")
    args = parser.parse_args()
    if args.json_stdin:
        replay()
    else:
        print(json.dumps(verify(), sort_keys=True))


if __name__ == "__main__":
    main()
