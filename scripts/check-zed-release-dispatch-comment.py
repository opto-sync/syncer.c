#!/usr/bin/env python3
"""Validate the trusted owner comment that dispatches the protected release.

This script is credential-free. The workflow fetches the already-merged pull
request and its changed-file list through read-only API calls, then this module
proves that the comment can only dispatch the reviewed one-file activation.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

REPOSITORY = "opto-sync/syncer.c"
ACTIVATION_PR = 20
ACTIVATION_MERGE_SHA = "39aa65805dde93f29945e29cf66b830e0b55868a"
ACTIVATION_BRANCH = "agent/den-1476-publish-syncer-v0.2.1"
ACTIVATION_FILE = "release/zed-publication-activation.v1.json"
ALLOWED_AUTHOR = "ORESoftware"
COMMAND = "/publish-approved-syncer-v0.2.1"
WORKFLOW_FILE = "approved-zed-release.yml"
SHA = re.compile(r"^[0-9a-f]{40}$")


class DispatchCommentError(ValueError):
    pass


def fail(message: str) -> "NoReturn":
    raise DispatchCommentError(message)


def load_json(path: Path, label: str) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot load {label}: {exc}")


def nested(value: Any, *keys: str) -> Any:
    current = value
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def validate(event: Any, pull: Any, files: Any) -> dict[str, Any]:
    if not isinstance(event, dict):
        fail("issue_comment event must be an object")
    if event.get("action") != "created":
        fail("issue_comment action must be created")
    if nested(event, "repository", "full_name") != REPOSITORY:
        fail("event repository differs")
    if nested(event, "issue", "number") != ACTIVATION_PR:
        fail("comment is not on the reviewed activation PR")
    if not isinstance(nested(event, "issue", "pull_request"), dict):
        fail("comment target is not a pull request")
    if nested(event, "comment", "user", "login") != ALLOWED_AUTHOR:
        fail("comment author differs")
    association = nested(event, "comment", "author_association")
    if association not in {"OWNER", "MEMBER"}:
        fail("comment author is not an organization owner/member")
    if nested(event, "comment", "body") != COMMAND:
        fail("comment body differs from the exact dispatch command")
    comment_id = nested(event, "comment", "id")
    if not isinstance(comment_id, int) or comment_id <= 0:
        fail("comment id is invalid")

    if not isinstance(pull, dict):
        fail("pull request response must be an object")
    if pull.get("number") != ACTIVATION_PR:
        fail("pull request number differs")
    if pull.get("state") != "closed":
        fail("activation PR must be closed")
    if pull.get("merged") is not True or pull.get("merged_at") is None:
        fail("activation PR must be merged")
    if pull.get("merge_commit_sha") != ACTIVATION_MERGE_SHA:
        fail("activation merge commit differs")
    if not SHA.fullmatch(str(pull.get("merge_commit_sha", ""))):
        fail("activation merge commit is malformed")
    if nested(pull, "base", "ref") != "main":
        fail("activation base branch differs")
    if nested(pull, "head", "ref") != ACTIVATION_BRANCH:
        fail("activation head branch differs")
    if nested(pull, "head", "repo", "full_name") != REPOSITORY:
        fail("activation head repository differs")
    if nested(pull, "user", "login") != ALLOWED_AUTHOR:
        fail("activation PR author differs")

    if not isinstance(files, list) or not all(
        isinstance(item, str) and item for item in files
    ):
        fail("changed files must be a string array")
    if len(files) != len(set(files)):
        fail("changed files contain duplicates")
    if files != [ACTIVATION_FILE]:
        fail("activation PR changed files differ from the one-file contract")

    return {
        "schemaVersion": 1,
        "readOnlyValidation": True,
        "repository": REPOSITORY,
        "activationPullRequest": ACTIVATION_PR,
        "activationMergeSha": ACTIVATION_MERGE_SHA,
        "activationFile": ACTIVATION_FILE,
        "commentId": comment_id,
        "commentAuthor": ALLOWED_AUTHOR,
        "command": COMMAND,
        "workflow": WORKFLOW_FILE,
        "dispatch": {
            "ref": "main",
            "inputs": {"publish": True},
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--event", type=Path, required=True)
    parser.add_argument("--pull", type=Path, required=True)
    parser.add_argument("--files", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        receipt = validate(
            load_json(args.event, "issue_comment event"),
            load_json(args.pull, "activation pull request"),
            load_json(args.files, "activation changed files"),
        )
    except DispatchCommentError as exc:
        print(f"zed-release-dispatch-comment: {exc}", file=sys.stderr)
        return 1
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(receipt, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(
        f"validated owner release dispatch: PR #{ACTIVATION_PR}, "
        f"comment {receipt['commentId']}, workflow {WORKFLOW_FILE}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
