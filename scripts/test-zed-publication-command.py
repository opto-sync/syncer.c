#!/usr/bin/env python3
from __future__ import annotations

import copy
import importlib.util
import json
import sys
import unittest
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/check-zed-publication-command.py"
SPEC = importlib.util.spec_from_file_location("zed_publication_command", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def event() -> dict[str, Any]:
    return {
        "action": "created",
        "repository": {"full_name": MODULE.REPOSITORY},
        "issue": {
            "number": MODULE.PR_NUMBER,
            "pull_request": {"url": "https://example.invalid/pulls/20"},
        },
        "comment": {
            "id": 123456,
            "body": MODULE.COMMAND,
            "author_association": "OWNER",
            "user": {"login": MODULE.AUTHOR},
        },
    }


def pull() -> dict[str, Any]:
    return {
        "number": MODULE.PR_NUMBER,
        "state": "closed",
        "merged": True,
        "merged_at": "2026-08-03T00:00:00Z",
        "merge_commit_sha": MODULE.ACTIVATION_MERGE_SHA,
        "base": {"ref": "main"},
        "head": {
            "ref": MODULE.ACTIVATION_BRANCH,
            "repo": {"full_name": MODULE.REPOSITORY},
        },
        "user": {"login": MODULE.AUTHOR},
    }


def files() -> list[dict[str, str]]:
    return [{"filename": MODULE.ACTIVATION_PATH}]


class FixtureClient:
    def __init__(
        self,
        *,
        pull_value: Any | None = None,
        file_value: Any | None = None,
        tag_ref: Any | None = None,
        tag_objects: dict[str, Any] | None = None,
    ):
        self.pull_value = copy.deepcopy(pull_value if pull_value is not None else pull())
        self.file_value = copy.deepcopy(file_value if file_value is not None else files())
        self.tag_ref = (
            tag_ref
            if tag_ref is not None
            else MODULE.GitHubApiError(404, MODULE.tag_ref_resource("v0.2.1"))
        )
        self.tag_objects = tag_objects or {}
        self.requests: list[tuple[str, str]] = []

    def get_json(self, resource: str) -> Any:
        self.requests.append(("json", resource))
        if resource == MODULE.pull_resource():
            if isinstance(self.pull_value, Exception):
                raise self.pull_value
            return copy.deepcopy(self.pull_value)
        if resource == MODULE.tag_ref_resource("v0.2.1"):
            if isinstance(self.tag_ref, Exception):
                raise self.tag_ref
            return copy.deepcopy(self.tag_ref)
        if "/git/tags/" in resource:
            sha = resource.rsplit("/", 1)[-1]
            return copy.deepcopy(self.tag_objects[sha])
        raise AssertionError(f"unexpected resource: {resource}")

    def get_paginated(self, resource: str) -> list[Any]:
        self.requests.append(("paginated", resource))
        if resource != MODULE.pull_files_resource():
            raise AssertionError(f"unexpected paginated resource: {resource}")
        if isinstance(self.file_value, Exception):
            raise self.file_value
        return copy.deepcopy(self.file_value)


class PublicationCommandTests(unittest.TestCase):
    def test_valid_exact_command_with_absent_tag_passes(self):
        context = MODULE.build_context(event(), FixtureClient())
        self.assertTrue(context["readOnly"])
        self.assertEqual(context["changedFiles"], [MODULE.ACTIVATION_PATH])
        self.assertEqual(
            context["tagState"],
            {"exists": False, "resolvedCommit": None, "chain": []},
        )
        result = MODULE.validate_context(
            event(),
            context,
            ROOT / MODULE.ACTIVATION_VALIDATOR.APPROVAL_PATH,
            ROOT / MODULE.ACTIVATION_VALIDATOR.ACTIVATION_PATH,
        )
        self.assertEqual(result["command"]["command"], MODULE.COMMAND)
        self.assertEqual(
            result["approval"]["targetSha"],
            "8d2b275a89062403666f4bdf196d246a07c84484",
        )

    def test_existing_direct_or_annotated_approved_tag_is_idempotent(self):
        approval = MODULE.ACTIVATION_VALIDATOR.load_object(
            ROOT / MODULE.ACTIVATION_VALIDATOR.APPROVAL_PATH,
            "approval",
        )
        target = approval["targetSha"]
        direct = FixtureClient(
            tag_ref={
                "ref": "refs/tags/v0.2.1",
                "object": {"type": "commit", "sha": target},
            }
        )
        direct_state = MODULE.build_context(event(), direct)["tagState"]
        self.assertEqual(direct_state["resolvedCommit"], target)

        tag_sha = "b" * 40
        annotated = FixtureClient(
            tag_ref={
                "ref": "refs/tags/v0.2.1",
                "object": {"type": "tag", "sha": tag_sha},
            },
            tag_objects={
                tag_sha: {"object": {"type": "commit", "sha": target}}
            },
        )
        annotated_state = MODULE.build_context(event(), annotated)["tagState"]
        self.assertEqual(
            annotated_state["chain"],
            [
                {"type": "tag", "sha": tag_sha},
                {"type": "commit", "sha": target},
            ],
        )

    def test_comment_body_is_byte_exact(self):
        for body in (
            MODULE.COMMAND + "\n",
            " " + MODULE.COMMAND,
            MODULE.COMMAND + " ",
            MODULE.COMMAND + "\n" + MODULE.COMMAND,
            "/publish-approved-syncer-v0.2.0",
            "",
            "gh" + "p_not_a_real_token",
        ):
            with self.subTest(body=body):
                value = event()
                value["comment"]["body"] = body
                with self.assertRaises(MODULE.CommandError):
                    MODULE.validate_comment_event(value)

    def test_wrong_event_repository_issue_author_association_and_shape_fail(self):
        mutations = {
            "action": lambda value: value.update(action="edited"),
            "repository": lambda value: value["repository"].update(full_name="fork/syncer.c"),
            "issue": lambda value: value["issue"].update(number=21),
            "not PR": lambda value: value["issue"].pop("pull_request"),
            "author": lambda value: value["comment"]["user"].update(login="attacker"),
            "association": lambda value: value["comment"].update(author_association="NONE"),
            "comment id": lambda value: value["comment"].update(id=0),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label):
                value = event()
                mutate(value)
                with self.assertRaises(MODULE.CommandError):
                    MODULE.validate_comment_event(value)

    def test_wrong_pr_metadata_fails(self):
        mutations = {
            "number": lambda value: value.update(number=21),
            "state": lambda value: value.update(state="open"),
            "merged": lambda value: value.update(merged=False, merged_at=None),
            "merge SHA": lambda value: value.update(merge_commit_sha="f" * 40),
            "base": lambda value: value["base"].update(ref="release"),
            "branch": lambda value: value["head"].update(ref="agent/other"),
            "head repository": lambda value: value["head"]["repo"].update(full_name="fork/syncer.c"),
            "author": lambda value: value["user"].update(login="attacker"),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label):
                value = pull()
                mutate(value)
                with self.assertRaises(MODULE.CommandError):
                    MODULE.validate_pr(value)

    def test_changed_file_set_is_exact_ordered_and_unique(self):
        cases = (
            [],
            [{"filename": "README.md"}],
            [{"filename": MODULE.ACTIVATION_PATH}, {"filename": "README.md"}],
            [{"filename": MODULE.ACTIVATION_PATH}, {"filename": MODULE.ACTIVATION_PATH}],
            [{"not_filename": MODULE.ACTIVATION_PATH}],
        )
        for value in cases:
            with self.subTest(value=value):
                with self.assertRaises(MODULE.CommandError):
                    MODULE.validate_changed_files(value)

    def test_conflicting_existing_tag_fails_before_release(self):
        client = FixtureClient(
            tag_ref={
                "ref": "refs/tags/v0.2.1",
                "object": {"type": "commit", "sha": "c" * 40},
            }
        )
        with self.assertRaisesRegex(MODULE.CommandError, "existing tag resolves"):
            MODULE.build_context(event(), client)

    def test_invalid_tag_chain_fails(self):
        target = "8d2b275a89062403666f4bdf196d246a07c84484"
        cases = (
            {"exists": False, "resolvedCommit": target, "chain": []},
            {"exists": True, "resolvedCommit": target, "chain": []},
            {
                "exists": True,
                "resolvedCommit": target,
                "chain": [{"type": "blob", "sha": target}],
            },
            {
                "exists": True,
                "resolvedCommit": target,
                "chain": [{"type": "commit", "sha": "f" * 40}],
            },
            {
                "exists": True,
                "resolvedCommit": target,
                "chain": [{"type": "commit", "sha": target, "extra": True}],
            },
        )
        for value in cases:
            with self.subTest(value=value):
                with self.assertRaises(MODULE.CommandError):
                    MODULE.validate_tag_state(value, target)

    def test_context_tampering_fails(self):
        context = MODULE.build_context(event(), FixtureClient())
        mutations = {
            "readOnly": lambda value: value.update(readOnly=False),
            "event": lambda value: value["event"].update(author="attacker"),
            "files": lambda value: value.update(changedFiles=["README.md"]),
            "tag": lambda value: value.update(
                tagState={
                    "exists": True,
                    "resolvedCommit": "f" * 40,
                    "chain": [{"type": "commit", "sha": "f" * 40}],
                }
            ),
            "unknown": lambda value: value.update(secretToken="no"),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label):
                value = copy.deepcopy(context)
                mutate(value)
                with self.assertRaises(MODULE.CommandError):
                    MODULE.validate_context(
                        event(),
                        value,
                        ROOT / MODULE.ACTIVATION_VALIDATOR.APPROVAL_PATH,
                        ROOT / MODULE.ACTIVATION_VALIDATOR.ACTIVATION_PATH,
                    )

    def test_context_contains_no_token_or_authorization_data(self):
        context = MODULE.build_context(event(), FixtureClient())
        serialized = json.dumps(context).lower()
        self.assertNotIn("authorization", serialized)
        self.assertNotIn("bearer", serialized)
        self.assertNotIn("sync_fleet_token", serialized)
        self.assertNotIn("ghp_", serialized)

    def test_api_errors_are_bounded_and_body_free(self):
        resource = MODULE.pull_resource()
        error = MODULE.GitHubApiError(403, resource)
        text = str(error)
        self.assertEqual(text, f"GitHub API returned HTTP 403 for {resource}")
        self.assertNotIn("authorization", text.lower())
        self.assertNotIn("bearer", text.lower())
        self.assertNotIn("response", text.lower())

    def test_paginated_file_fetch_is_bounded(self):
        class PagedClient(MODULE.GitHubClient):
            def __init__(self):
                self._token = "test-only"
                self._api_url = "https://example.invalid"
                self._timeout_seconds = 1
                self._max_pages = 2
                self.calls = []

            def get_json(self, resource):
                self.calls.append(resource)
                if resource.endswith("page=1"):
                    return [{"filename": f"file-{index}"} for index in range(100)]
                return [{"filename": MODULE.ACTIVATION_PATH}]

        client = PagedClient()
        result = client.get_paginated(MODULE.pull_files_resource())
        self.assertEqual(len(result), 101)
        self.assertEqual(len(client.calls), 2)

        class EndlessClient(PagedClient):
            def get_json(self, resource):
                return [{"filename": f"file-{index}"} for index in range(100)]

        with self.assertRaisesRegex(MODULE.CommandError, "exceeded 2 pages"):
            EndlessClient().get_paginated(MODULE.pull_files_resource())


if __name__ == "__main__":
    unittest.main()
