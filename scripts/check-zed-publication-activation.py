#!/usr/bin/env python3
"""Validate the one-file, merged-PR activation for an approved Zed release.

The validator is credential-free. It treats the committed release approval as
the immutable source of package identity and allows publication only when a
merged pull request changes exactly one activation JSON file. The GitHub
Actions workflow performs the network reads and passes only the event document
and changed filenames into this script.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

REPOSITORY = "opto-sync/syncer.c"
APPROVAL_PATH = "release/zed-release-approval.v1.json"
ACTIVATION_PATH = "release/zed-publication-activation.v1.json"
ACTIVATION_BRANCH = "agent/den-1476-publish-syncer-v0.2.1"
ACTIVATION_AUTHOR = "ORESoftware"
ACTIVATION_ID = "syncer-v0.2.1-clean-source"
PUBLICATION_ENVIRONMENT = "zed-production-release"
EXPECTED_ISSUES = {"DEN-309", "DEN-363", "DEN-1476"}
SHA = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
ARTIFACT_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
ISSUE = re.compile(r"^DEN-[1-9][0-9]*$")
SECRET_KEY = re.compile(
    r"(?:token|secret|password|credential|private[_-]?key|authorization)",
    re.IGNORECASE,
)
ACTIVATION_FIELDS = {
    "schemaVersion",
    "status",
    "activationId",
    "repository",
    "approvalPath",
    "approvalSha256",
    "targetSha",
    "targetTreeSha",
    "version",
    "tag",
    "packagingMethod",
    "packages",
    "evidence",
    "allowedBranch",
    "allowedAuthor",
    "expectedChangedFiles",
    "publicationEnvironment",
    "requestedByIssues",
}


class ActivationError(ValueError):
    pass


def fail(message: str) -> "NoReturn":
    raise ActivationError(message)


def load_object(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot load {label}: {exc}")
    if not isinstance(value, dict):
        fail(f"{label} must contain a JSON object")
    return value


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def require_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        fail(f"{label} must be a non-empty string")
    return value.strip()


def require_sha(value: Any, label: str) -> str:
    text = require_text(value, label)
    if not SHA.fullmatch(text):
        fail(f"{label} must be a lowercase 40-character commit SHA")
    return text


def require_sha256(value: Any, label: str) -> str:
    text = require_text(value, label)
    if not SHA256.fullmatch(text) or text == "0" * 64:
        fail(f"{label} must be a non-zero lowercase SHA-256")
    return text


def require_positive_int(value: Any, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        fail(f"{label} must be a positive integer")
    return value


def reject_secret_fields(value: Any, path: str = "activation") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if not isinstance(key, str):
                fail(f"{path} contains a non-string key")
            if SECRET_KEY.search(key):
                fail(f"{path}.{key} is a forbidden secret-like field")
            reject_secret_fields(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            reject_secret_fields(child, f"{path}[{index}]")


def validate_approval(approval: dict[str, Any]) -> None:
    if approval.get("schemaVersion") != 1:
        fail("approval.schemaVersion must be 1")
    if approval.get("status") != "approved":
        fail("approval.status must be approved")
    if approval.get("approvalRevision") != 2:
        fail("approval.approvalRevision must be 2")
    if approval.get("repository") != REPOSITORY:
        fail("approval.repository differs from the release repository")
    target_sha = require_sha(approval.get("targetSha"), "approval.targetSha")
    require_sha(approval.get("targetTreeSha"), "approval.targetTreeSha")
    require_sha(approval.get("cleanEvidenceMergeSha"), "approval.cleanEvidenceMergeSha")
    version = require_text(approval.get("version"), "approval.version")
    if approval.get("tag") != f"v{version}":
        fail("approval.tag must equal v{version}")
    if approval.get("packagingMethod") != "independent_untouched_checkouts_before_build":
        fail("approval.packagingMethod is not the clean-source method")

    packages = approval.get("zedPackages")
    if not isinstance(packages, list) or len(packages) != 3:
        fail("approval.zedPackages must contain exactly three packages")
    expected_names = ["syncer", "syncer-c", "syncer-wasm"]
    actual_names: list[str] = []
    seen_archives: set[str] = set()
    for index, package in enumerate(packages):
        label = f"approval.zedPackages[{index}]"
        if not isinstance(package, dict):
            fail(f"{label} must be an object")
        name = require_text(package.get("name"), f"{label}.name")
        actual_names.append(name)
        archive = require_text(package.get("archive"), f"{label}.archive")
        if Path(archive).name != archive or not archive.endswith(".tar.gz"):
            fail(f"{label}.archive must be a safe tar.gz filename")
        if archive in seen_archives:
            fail(f"duplicate approval archive: {archive}")
        seen_archives.add(archive)
        require_sha256(package.get("sha256"), f"{label}.sha256")
        require_positive_int(package.get("size"), f"{label}.size")
        require_positive_int(package.get("fileCount"), f"{label}.fileCount")
    if actual_names != expected_names:
        fail("approval package order/identity differs from syncer, syncer-c, syncer-wasm")

    evidence = approval.get("evidence")
    if not isinstance(evidence, dict):
        fail("approval.evidence must be an object")
    if evidence.get("repository") != "opto-sync/opto-sync-e2e":
        fail("approval evidence repository differs")
    if evidence.get("mergeCommit") != approval.get("cleanEvidenceMergeSha"):
        fail("approval evidence merge differs from cleanEvidenceMergeSha")
    require_positive_int(evidence.get("runId"), "approval.evidence.runId")
    require_positive_int(evidence.get("artifactId"), "approval.evidence.artifactId")
    digest = require_text(evidence.get("artifactDigest"), "approval.evidence.artifactDigest")
    if not ARTIFACT_DIGEST.fullmatch(digest):
        fail("approval.evidence.artifactDigest must use sha256:<64 hex>")

    tooling = approval.get("tooling")
    if not isinstance(tooling, dict):
        fail("approval.tooling must be an object")
    require_sha(tooling.get("zedCliSha"), "approval.tooling.zedCliSha")
    require_sha(tooling.get("zedInterfacesSha"), "approval.tooling.zedInterfacesSha")
    issues = approval.get("linearIssues")
    if not isinstance(issues, list) or not {"DEN-309", "DEN-363"} <= set(issues):
        fail("approval.linearIssues must include DEN-309 and DEN-363")
    if target_sha == approval.get("cleanEvidenceMergeSha"):
        fail("approval target source cannot equal the evidence-controller merge")


def package_projection(packages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "name": package["name"],
            "sha256": package["sha256"],
            "size": package["size"],
            "fileCount": package["fileCount"],
        }
        for package in packages
    ]


def evidence_projection(evidence: dict[str, Any]) -> dict[str, Any]:
    return {
        "mergeCommit": evidence["mergeCommit"],
        "runId": evidence["runId"],
        "artifactId": evidence["artifactId"],
        "artifactDigest": evidence["artifactDigest"],
    }


def validate_activation(
    approval: dict[str, Any],
    activation: dict[str, Any],
    approval_path: Path,
) -> None:
    reject_secret_fields(activation)
    unknown = set(activation) - ACTIVATION_FIELDS
    missing = ACTIVATION_FIELDS - set(activation)
    if unknown:
        fail("activation contains unknown fields: " + ", ".join(sorted(unknown)))
    if missing:
        fail("activation is missing fields: " + ", ".join(sorted(missing)))
    if activation.get("schemaVersion") != 1:
        fail("activation.schemaVersion must be 1")
    if activation.get("status") != "approved_for_publication":
        fail("activation.status must be approved_for_publication")
    if activation.get("activationId") != ACTIVATION_ID:
        fail("activation.activationId differs")
    if activation.get("repository") != REPOSITORY:
        fail("activation.repository differs")
    if activation.get("approvalPath") != APPROVAL_PATH:
        fail("activation.approvalPath differs")
    if activation.get("approvalSha256") != file_sha256(approval_path):
        fail("activation.approvalSha256 differs from the committed approval file")
    for field in ("targetSha", "targetTreeSha", "version", "tag", "packagingMethod"):
        if activation.get(field) != approval.get(field):
            fail(f"activation.{field} differs from approval.{field}")
    if activation.get("packages") != package_projection(approval["zedPackages"]):
        fail("activation.packages differs from approved package evidence")
    if activation.get("evidence") != evidence_projection(approval["evidence"]):
        fail("activation.evidence differs from approved clean evidence")
    if activation.get("allowedBranch") != ACTIVATION_BRANCH:
        fail("activation.allowedBranch differs")
    if activation.get("allowedAuthor") != ACTIVATION_AUTHOR:
        fail("activation.allowedAuthor differs")
    if activation.get("expectedChangedFiles") != [ACTIVATION_PATH]:
        fail("activation.expectedChangedFiles must contain only the activation file")
    if activation.get("publicationEnvironment") != PUBLICATION_ENVIRONMENT:
        fail("activation.publicationEnvironment differs")
    issues = activation.get("requestedByIssues")
    if not isinstance(issues, list) or set(issues) != EXPECTED_ISSUES:
        fail("activation.requestedByIssues must contain exactly DEN-309, DEN-363, DEN-1476")
    if not all(isinstance(issue, str) and ISSUE.fullmatch(issue) for issue in issues):
        fail("activation.requestedByIssues contains an invalid issue identifier")


def validate_event(
    event: dict[str, Any],
    changed_files: list[Any],
    activation: dict[str, Any],
) -> None:
    if event.get("action") != "closed":
        fail("GitHub event action must be closed")
    pull = event.get("pull_request")
    if not isinstance(pull, dict):
        fail("GitHub event lacks pull_request")
    if pull.get("merged") is not True or pull.get("merged_at") is None:
        fail("activation pull request is not merged")
    if pull.get("state") != "closed":
        fail("activation pull request state must be closed")
    if not isinstance(pull.get("number"), int) or pull["number"] <= 0:
        fail("activation pull request number is invalid")
    base = pull.get("base")
    head = pull.get("head")
    user = pull.get("user")
    if not isinstance(base, dict) or base.get("ref") != "main":
        fail("activation pull request base must be main")
    if not isinstance(head, dict) or head.get("ref") != activation["allowedBranch"]:
        fail("activation pull request head branch differs")
    head_repo = head.get("repo") if isinstance(head, dict) else None
    if not isinstance(head_repo, dict) or head_repo.get("full_name") != REPOSITORY:
        fail("activation pull request must originate from the same repository")
    if not isinstance(user, dict) or user.get("login") != activation["allowedAuthor"]:
        fail("activation pull request author differs")
    merge_sha = pull.get("merge_commit_sha")
    require_sha(merge_sha, "pull_request.merge_commit_sha")
    event_repository = event.get("repository")
    if not isinstance(event_repository, dict) or event_repository.get("full_name") != REPOSITORY:
        fail("GitHub event repository differs")
    if not isinstance(changed_files, list) or not all(
        isinstance(item, str) and item for item in changed_files
    ):
        fail("changed files must be a non-empty string array")
    if len(changed_files) != len(set(changed_files)):
        fail("changed files contain duplicates")
    if changed_files != activation["expectedChangedFiles"]:
        fail("activation pull request changed files differ from the one-file contract")


def validate_contract(approval_path: Path, activation_path: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    approval = load_object(approval_path, "approval")
    activation = load_object(activation_path, "activation")
    validate_approval(approval)
    validate_activation(approval, activation, approval_path)
    return approval, activation


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("validate-contract", "validate-event"))
    parser.add_argument("--approval", type=Path, required=True)
    parser.add_argument("--activation", type=Path, required=True)
    parser.add_argument("--event", type=Path)
    parser.add_argument("--files", type=Path)
    args = parser.parse_args()
    try:
        _, activation = validate_contract(args.approval, args.activation)
        if args.command == "validate-event":
            if args.event is None or args.files is None:
                fail("validate-event requires --event and --files")
            event = load_object(args.event, "GitHub event")
            try:
                changed_files = json.loads(args.files.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                fail(f"cannot load changed files: {exc}")
            validate_event(event, changed_files, activation)
    except ActivationError as exc:
        print(f"zed-publication-activation: {exc}", file=sys.stderr)
        return 1
    print(f"validated {args.command}: {ACTIVATION_ID}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
