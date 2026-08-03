#!/usr/bin/env python3
from __future__ import annotations

import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/check-zed-publication-activation.py"
APPROVAL_PATH = ROOT / "release/zed-release-approval.v1.json"
SPEC = importlib.util.spec_from_file_location("zed_publication_activation", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def activation_for(approval_path: Path, approval: dict) -> dict:
    return {
        "schemaVersion": 1,
        "status": "approved_for_publication",
        "activationId": MODULE.ACTIVATION_ID,
        "repository": MODULE.REPOSITORY,
        "approvalPath": MODULE.APPROVAL_PATH,
        "approvalSha256": MODULE.file_sha256(approval_path),
        "targetSha": approval["targetSha"],
        "targetTreeSha": approval["targetTreeSha"],
        "version": approval["version"],
        "tag": approval["tag"],
        "packagingMethod": approval["packagingMethod"],
        "packages": MODULE.package_projection(approval["zedPackages"]),
        "evidence": MODULE.evidence_projection(approval["evidence"]),
        "allowedBranch": MODULE.ACTIVATION_BRANCH,
        "allowedAuthor": MODULE.ACTIVATION_AUTHOR,
        "expectedChangedFiles": [MODULE.ACTIVATION_PATH],
        "publicationEnvironment": MODULE.PUBLICATION_ENVIRONMENT,
        "requestedByIssues": ["DEN-309", "DEN-363", "DEN-1476"],
    }


def event_for(activation: dict) -> dict:
    return {
        "action": "closed",
        "repository": {"full_name": MODULE.REPOSITORY},
        "pull_request": {
            "number": 99,
            "state": "closed",
            "merged": True,
            "merged_at": "2026-08-03T00:00:00Z",
            "merge_commit_sha": "a" * 40,
            "base": {"ref": "main"},
            "head": {
                "ref": activation["allowedBranch"],
                "repo": {"full_name": MODULE.REPOSITORY},
            },
            "user": {"login": activation["allowedAuthor"]},
        },
    }


class PublicationActivationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.approval = json.loads(APPROVAL_PATH.read_text(encoding="utf-8"))

    def with_contract(self):
        temporary = tempfile.TemporaryDirectory()
        root = Path(temporary.name)
        approval_path = root / "approval.json"
        write_json(approval_path, self.approval)
        activation = activation_for(approval_path, self.approval)
        activation_path = root / "activation.json"
        write_json(activation_path, activation)
        return temporary, approval_path, activation_path, activation

    def test_valid_contract_and_merged_one_file_event_pass(self):
        temporary, approval_path, activation_path, activation = self.with_contract()
        with temporary:
            approval, loaded = MODULE.validate_contract(approval_path, activation_path)
            self.assertEqual(approval["targetSha"], self.approval["targetSha"])
            self.assertEqual(loaded, activation)
            MODULE.validate_event(
                event_for(activation),
                [MODULE.ACTIVATION_PATH],
                activation,
            )

    def test_wrong_author_branch_base_repository_and_merge_state_fail(self):
        mutations = {
            "author": lambda event: event["pull_request"]["user"].update(login="attacker"),
            "branch": lambda event: event["pull_request"]["head"].update(ref="main"),
            "base": lambda event: event["pull_request"]["base"].update(ref="release"),
            "head repository": lambda event: event["pull_request"]["head"]["repo"].update(full_name="fork/syncer.c"),
            "event repository": lambda event: event["repository"].update(full_name="fork/syncer.c"),
            "merged": lambda event: event["pull_request"].update(merged=False, merged_at=None),
        }
        temporary, _, _, activation = self.with_contract()
        with temporary:
            for label, mutate in mutations.items():
                with self.subTest(label=label):
                    event = event_for(activation)
                    mutate(event)
                    with self.assertRaises(MODULE.ActivationError):
                        MODULE.validate_event(
                            event,
                            [MODULE.ACTIVATION_PATH],
                            activation,
                        )

    def test_changed_file_set_must_be_exact_ordered_and_unique(self):
        temporary, _, _, activation = self.with_contract()
        with temporary:
            event = event_for(activation)
            cases = (
                [],
                [MODULE.ACTIVATION_PATH, "README.md"],
                [MODULE.ACTIVATION_PATH, MODULE.ACTIVATION_PATH],
                ["README.md"],
            )
            for files in cases:
                with self.subTest(files=files):
                    with self.assertRaises(MODULE.ActivationError):
                        MODULE.validate_event(event, files, activation)

    def test_approval_digest_and_identity_cannot_drift(self):
        temporary, approval_path, activation_path, activation = self.with_contract()
        with temporary:
            mutations = {
                "approval digest": lambda value: value.update(approvalSha256="1" * 64),
                "target SHA": lambda value: value.update(targetSha="b" * 40),
                "tree SHA": lambda value: value.update(targetTreeSha="c" * 40),
                "version": lambda value: value.update(version="9.9.9"),
                "tag": lambda value: value.update(tag="v9.9.9"),
                "method": lambda value: value.update(packagingMethod="dirty_worktree"),
            }
            for label, mutate in mutations.items():
                with self.subTest(label=label):
                    value = copy.deepcopy(activation)
                    mutate(value)
                    write_json(activation_path, value)
                    with self.assertRaises(MODULE.ActivationError):
                        MODULE.validate_contract(approval_path, activation_path)

    def test_package_and_evidence_projection_cannot_drift(self):
        temporary, approval_path, activation_path, activation = self.with_contract()
        with temporary:
            cases = []
            wrong_hash = copy.deepcopy(activation)
            wrong_hash["packages"][0]["sha256"] = "1" * 64
            cases.append(("package hash", wrong_hash))
            zero_hash = copy.deepcopy(activation)
            zero_hash["packages"][0]["sha256"] = "0" * 64
            cases.append(("zero package hash", zero_hash))
            wrong_size = copy.deepcopy(activation)
            wrong_size["packages"][0]["size"] += 1
            cases.append(("package size", wrong_size))
            wrong_count = copy.deepcopy(activation)
            wrong_count["packages"][0]["fileCount"] += 1
            cases.append(("package file count", wrong_count))
            wrong_run = copy.deepcopy(activation)
            wrong_run["evidence"]["runId"] += 1
            cases.append(("evidence run", wrong_run))
            wrong_artifact = copy.deepcopy(activation)
            wrong_artifact["evidence"]["artifactDigest"] = "sha256:" + "1" * 64
            cases.append(("evidence digest", wrong_artifact))
            for label, value in cases:
                with self.subTest(label=label):
                    write_json(activation_path, value)
                    with self.assertRaises(MODULE.ActivationError):
                        MODULE.validate_contract(approval_path, activation_path)

    def test_unknown_and_secret_like_fields_fail(self):
        temporary, approval_path, activation_path, activation = self.with_contract()
        with temporary:
            unknown = copy.deepcopy(activation)
            unknown["notes"] = "not reviewed"
            write_json(activation_path, unknown)
            with self.assertRaisesRegex(MODULE.ActivationError, "unknown fields"):
                MODULE.validate_contract(approval_path, activation_path)

            secret = copy.deepcopy(activation)
            secret["registryToken"] = "redacted"
            write_json(activation_path, secret)
            with self.assertRaisesRegex(MODULE.ActivationError, "secret-like"):
                MODULE.validate_contract(approval_path, activation_path)

    def test_allowed_branch_author_environment_and_issues_are_fixed(self):
        temporary, approval_path, activation_path, activation = self.with_contract()
        with temporary:
            cases = []
            wrong_branch = copy.deepcopy(activation)
            wrong_branch["allowedBranch"] = "agent/den-1476-other"
            cases.append(wrong_branch)
            wrong_author = copy.deepcopy(activation)
            wrong_author["allowedAuthor"] = "someone-else"
            cases.append(wrong_author)
            wrong_environment = copy.deepcopy(activation)
            wrong_environment["publicationEnvironment"] = "unprotected"
            cases.append(wrong_environment)
            wrong_issues = copy.deepcopy(activation)
            wrong_issues["requestedByIssues"] = ["DEN-309", "DEN-363"]
            cases.append(wrong_issues)
            wrong_files = copy.deepcopy(activation)
            wrong_files["expectedChangedFiles"] = [MODULE.ACTIVATION_PATH, "README.md"]
            cases.append(wrong_files)
            for value in cases:
                write_json(activation_path, value)
                with self.assertRaises(MODULE.ActivationError):
                    MODULE.validate_contract(approval_path, activation_path)

    def test_invalid_approval_never_reaches_activation(self):
        cases = []
        wrong_status = copy.deepcopy(self.approval)
        wrong_status["status"] = "candidate"
        cases.append(wrong_status)
        zero_hash = copy.deepcopy(self.approval)
        zero_hash["zedPackages"][0]["sha256"] = "0" * 64
        cases.append(zero_hash)
        duplicate_archive = copy.deepcopy(self.approval)
        duplicate_archive["zedPackages"][1]["archive"] = duplicate_archive["zedPackages"][0]["archive"]
        cases.append(duplicate_archive)
        wrong_evidence = copy.deepcopy(self.approval)
        wrong_evidence["evidence"]["mergeCommit"] = "d" * 40
        cases.append(wrong_evidence)
        for approval in cases:
            with self.subTest(status=approval.get("status")), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                approval_path = root / "approval.json"
                write_json(approval_path, approval)
                activation_path = root / "activation.json"
                write_json(activation_path, activation_for(approval_path, approval))
                with self.assertRaises(MODULE.ActivationError):
                    MODULE.validate_contract(approval_path, activation_path)


if __name__ == "__main__":
    unittest.main()
