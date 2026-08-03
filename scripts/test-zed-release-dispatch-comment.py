#!/usr/bin/env python3
from __future__ import annotations

import copy
import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/check-zed-release-dispatch-comment.py"
SPEC = importlib.util.spec_from_file_location("zed_release_dispatch_comment", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def event() -> dict:
    return {
        "action": "created",
        "repository": {"full_name": MODULE.REPOSITORY},
        "issue": {
            "number": MODULE.ACTIVATION_PR,
            "pull_request": {"url": "https://api.github.invalid/pulls/20"},
        },
        "comment": {
            "id": 12345,
            "body": MODULE.COMMAND,
            "author_association": "OWNER",
            "user": {"login": MODULE.ALLOWED_AUTHOR},
        },
    }


def pull() -> dict:
    return {
        "number": MODULE.ACTIVATION_PR,
        "state": "closed",
        "merged": True,
        "merged_at": "2026-08-03T00:00:00Z",
        "merge_commit_sha": MODULE.ACTIVATION_MERGE_SHA,
        "base": {"ref": "main"},
        "head": {
            "ref": MODULE.ACTIVATION_BRANCH,
            "repo": {"full_name": MODULE.REPOSITORY},
        },
        "user": {"login": MODULE.ALLOWED_AUTHOR},
    }


class ReleaseDispatchCommentTests(unittest.TestCase):
    def test_valid_owner_comment_returns_bounded_dispatch_receipt(self):
        receipt = MODULE.validate(event(), pull(), [MODULE.ACTIVATION_FILE])
        self.assertEqual(receipt["workflow"], MODULE.WORKFLOW_FILE)
        self.assertEqual(
            receipt["dispatch"],
            {"ref": "main", "inputs": {"publish": True}},
        )
        serialized = json.dumps(receipt).lower()
        for marker in ("token", "secret", "authorization", "bearer"):
            self.assertNotIn(marker, serialized)

    def test_event_identity_and_exact_command_are_fixed(self):
        mutations = {
            "action": lambda value: value.update(action="edited"),
            "repository": lambda value: value["repository"].update(full_name="fork/syncer.c"),
            "issue": lambda value: value["issue"].update(number=21),
            "not a PR": lambda value: value["issue"].pop("pull_request"),
            "author": lambda value: value["comment"]["user"].update(login="attacker"),
            "association": lambda value: value["comment"].update(author_association="NONE"),
            "body": lambda value: value["comment"].update(body=MODULE.COMMAND + " now"),
            "comment id": lambda value: value["comment"].update(id=0),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label):
                candidate = event()
                mutate(candidate)
                with self.assertRaises(MODULE.DispatchCommentError):
                    MODULE.validate(candidate, pull(), [MODULE.ACTIVATION_FILE])

    def test_activation_pull_identity_cannot_drift(self):
        mutations = {
            "number": lambda value: value.update(number=19),
            "state": lambda value: value.update(state="open"),
            "not merged": lambda value: value.update(merged=False, merged_at=None),
            "merge SHA": lambda value: value.update(merge_commit_sha="a" * 40),
            "base": lambda value: value["base"].update(ref="release"),
            "head": lambda value: value["head"].update(ref="agent/other"),
            "head repo": lambda value: value["head"]["repo"].update(full_name="fork/syncer.c"),
            "author": lambda value: value["user"].update(login="someone-else"),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label):
                candidate = pull()
                mutate(candidate)
                with self.assertRaises(MODULE.DispatchCommentError):
                    MODULE.validate(event(), candidate, [MODULE.ACTIVATION_FILE])

    def test_changed_file_set_is_exact_ordered_and_unique(self):
        cases = (
            [],
            ["README.md"],
            [MODULE.ACTIVATION_FILE, "README.md"],
            [MODULE.ACTIVATION_FILE, MODULE.ACTIVATION_FILE],
            [{"filename": MODULE.ACTIVATION_FILE}],
        )
        for files in cases:
            with self.subTest(files=files):
                with self.assertRaises(MODULE.DispatchCommentError):
                    MODULE.validate(event(), pull(), files)

    def test_member_association_is_permitted_but_contributor_is_not(self):
        member = event()
        member["comment"]["author_association"] = "MEMBER"
        self.assertTrue(
            MODULE.validate(member, pull(), [MODULE.ACTIVATION_FILE])["readOnlyValidation"]
        )
        contributor = event()
        contributor["comment"]["author_association"] = "CONTRIBUTOR"
        with self.assertRaises(MODULE.DispatchCommentError):
            MODULE.validate(contributor, pull(), [MODULE.ACTIVATION_FILE])


if __name__ == "__main__":
    unittest.main()
