#!/usr/bin/env python3
"""Validate and fetch the trusted exact-command syncer release retry context.

This command is a retry transport for an already merged and approved one-file
activation. It does not relax release identity. The only accepted trigger is an
exact issue comment on pull request #20 from ORESoftware with a trusted
repository association. Before any protected credential is available, the
script re-fetches the merged PR, its complete changed-file list, and current tag
state through GET-only GitHub API calls, then reuses the DEN-1476 activation
validator.

SYNC_FLEET_TOKEN is read only from the environment by `fetch-context`. It is
never accepted as an argument, written to the context file, or included in an
exception. HTTP response bodies are discarded on failure.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Protocol

ROOT = Path(__file__).resolve().parents[1]
ACTIVATION_VALIDATOR_PATH = ROOT / "scripts/check-zed-publication-activation.py"
SPEC = importlib.util.spec_from_file_location(
    "zed_publication_activation_for_command",
    ACTIVATION_VALIDATOR_PATH,
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load activation validator: {ACTIVATION_VALIDATOR_PATH}")
ACTIVATION_VALIDATOR = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = ACTIVATION_VALIDATOR
SPEC.loader.exec_module(ACTIVATION_VALIDATOR)

COMMAND = "/publish-approved-syncer-v0.2.1"
REPOSITORY = "opto-sync/syncer.c"
PR_NUMBER = 20
ACTIVATION_MERGE_SHA = "39aa65805dde93f29945e29cf66b830e0b55868a"
ACTIVATION_BRANCH = "agent/den-1476-publish-syncer-v0.2.1"
ACTIVATION_PATH = "release/zed-publication-activation.v1.json"
AUTHOR = "ORESoftware"
ALLOWED_ASSOCIATIONS = {"OWNER", "MEMBER", "COLLABORATOR"}
API_DEFAULT = "https://api.github.com"
SHA = re.compile(r"^[0-9a-f]{40}$")


class CommandError(ValueError):
    pass


class GitHubApiError(RuntimeError):
    def __init__(self, status: int, resource: str):
        super().__init__(f"GitHub API returned HTTP {status} for {resource}")
        self.status = status
        self.resource = resource


class Client(Protocol):
    def get_json(self, resource: str) -> Any: ...

    def get_paginated(self, resource: str) -> list[Any]: ...


def fail(message: str) -> "NoReturn":
    raise CommandError(message)


def load_json(path: Path, label: str) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot load {label}: {exc}")


def require_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail(f"{label} must be an object")
    return value


def require_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        fail(f"{label} must be a non-empty string")
    return value


def require_sha(value: Any, label: str) -> str:
    text = require_text(value, label)
    if not SHA.fullmatch(text):
        fail(f"{label} must be a lowercase 40-character SHA")
    return text


def repo_resource(repository: str) -> str:
    owner, name = repository.split("/", 1)
    return "/repos/{}/{}".format(
        urllib.parse.quote(owner, safe=""),
        urllib.parse.quote(name, safe=""),
    )


def pull_resource() -> str:
    return f"{repo_resource(REPOSITORY)}/pulls/{PR_NUMBER}"


def pull_files_resource() -> str:
    return f"{pull_resource()}/files"


def tag_ref_resource(tag: str) -> str:
    return f"{repo_resource(REPOSITORY)}/git/ref/tags/{urllib.parse.quote(tag, safe='')}"


class GitHubClient:
    def __init__(
        self,
        token: str,
        *,
        api_url: str = API_DEFAULT,
        timeout_seconds: int = 20,
        max_pages: int = 5,
    ):
        if not token:
            raise CommandError("SYNC_FLEET_TOKEN is required to fetch command context")
        self._token = token
        self._api_url = api_url.rstrip("/")
        self._timeout_seconds = timeout_seconds
        self._max_pages = max_pages

    def get_json(self, resource: str) -> Any:
        if not resource.startswith("/"):
            raise CommandError(f"unsafe GitHub resource path: {resource}")
        request = urllib.request.Request(
            self._api_url + resource,
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self._token}",
                "User-Agent": "opto-sync-publication-command/1",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout_seconds) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            raise GitHubApiError(exc.code, resource) from None
        except urllib.error.URLError as exc:
            reason = type(exc.reason).__name__
            raise RuntimeError(
                f"GitHub API transport failed for {resource}: {reason}"
            ) from None

    def get_paginated(self, resource: str) -> list[Any]:
        separator = "&" if "?" in resource else "?"
        result: list[Any] = []
        for page in range(1, self._max_pages + 1):
            value = self.get_json(f"{resource}{separator}per_page=100&page={page}")
            if not isinstance(value, list):
                raise CommandError(
                    f"paginated GitHub resource did not return an array: {resource}"
                )
            result.extend(value)
            if len(value) < 100:
                return result
        raise CommandError(
            f"paginated GitHub resource exceeded {self._max_pages} pages: {resource}"
        )


def validate_comment_event(event: Any) -> dict[str, Any]:
    event = require_object(event, "issue_comment event")
    if event.get("action") != "created":
        fail("issue_comment action must be created")
    repository = require_object(event.get("repository"), "event.repository")
    if repository.get("full_name") != REPOSITORY:
        fail("event repository differs")
    issue = require_object(event.get("issue"), "event.issue")
    if issue.get("number") != PR_NUMBER:
        fail(f"event issue number must be {PR_NUMBER}")
    if not isinstance(issue.get("pull_request"), dict):
        fail("event issue is not a pull request")
    comment = require_object(event.get("comment"), "event.comment")
    body = require_text(comment.get("body"), "event.comment.body")
    if body != COMMAND:
        fail("comment body must equal the exact publication command")
    user = require_object(comment.get("user"), "event.comment.user")
    if user.get("login") != AUTHOR:
        fail("comment author differs")
    association = comment.get("author_association")
    if association not in ALLOWED_ASSOCIATIONS:
        fail("comment author association is not trusted")
    comment_id = comment.get("id")
    if not isinstance(comment_id, int) or comment_id <= 0:
        fail("comment id must be a positive integer")
    return {
        "repository": REPOSITORY,
        "issueNumber": PR_NUMBER,
        "commentId": comment_id,
        "command": COMMAND,
        "author": AUTHOR,
        "association": association,
    }


def validate_pr(pr: Any) -> dict[str, Any]:
    pr = require_object(pr, "pull request")
    if pr.get("number") != PR_NUMBER:
        fail(f"pull request number must be {PR_NUMBER}")
    if pr.get("state") != "closed":
        fail("pull request state must be closed")
    if pr.get("merged") is not True or pr.get("merged_at") is None:
        fail("pull request must be merged")
    if pr.get("merge_commit_sha") != ACTIVATION_MERGE_SHA:
        fail("pull request merge SHA differs")
    base = require_object(pr.get("base"), "pull_request.base")
    if base.get("ref") != "main":
        fail("pull request base must be main")
    head = require_object(pr.get("head"), "pull_request.head")
    if head.get("ref") != ACTIVATION_BRANCH:
        fail("pull request head branch differs")
    head_repo = require_object(head.get("repo"), "pull_request.head.repo")
    if head_repo.get("full_name") != REPOSITORY:
        fail("pull request must originate from the same repository")
    user = require_object(pr.get("user"), "pull_request.user")
    if user.get("login") != AUTHOR:
        fail("pull request author differs")
    return pr


def validate_changed_files(files: Any) -> list[str]:
    if not isinstance(files, list) or not files:
        fail("changed files must be a non-empty array")
    names: list[str] = []
    for index, item in enumerate(files):
        if not isinstance(item, dict) or not isinstance(item.get("filename"), str):
            fail(f"changed file entry {index} lacks filename")
        names.append(item["filename"])
    if len(names) != len(set(names)):
        fail("changed files contain duplicates")
    if names != [ACTIVATION_PATH]:
        fail("pull request changed files differ from the exact one-file activation")
    return names


def resolve_tag_state(client: Client, tag: str) -> dict[str, Any]:
    resource = tag_ref_resource(tag)
    try:
        ref = client.get_json(resource)
    except GitHubApiError as exc:
        if exc.status == 404:
            return {"exists": False, "resolvedCommit": None, "chain": []}
        raise
    ref = require_object(ref, "tag reference")
    obj = require_object(ref.get("object"), "tag reference object")
    object_type = obj.get("type")
    object_sha = require_sha(obj.get("sha"), "tag object SHA")
    chain: list[dict[str, str]] = []
    for _ in range(5):
        chain.append({"type": str(object_type), "sha": object_sha})
        if object_type == "commit":
            return {
                "exists": True,
                "resolvedCommit": object_sha,
                "chain": chain,
            }
        if object_type != "tag":
            fail(f"unsupported tag object type: {object_type!r}")
        tag_object = require_object(
            client.get_json(
                f"{repo_resource(REPOSITORY)}/git/tags/{urllib.parse.quote(object_sha, safe='')}"
            ),
            "annotated tag",
        )
        nested = require_object(tag_object.get("object"), "annotated tag object")
        object_type = nested.get("type")
        object_sha = require_sha(nested.get("sha"), "annotated tag object SHA")
    fail("tag dereference exceeded five objects")


def validate_tag_state(tag_state: Any, approved_target_sha: str) -> dict[str, Any]:
    tag_state = require_object(tag_state, "tagState")
    if set(tag_state) != {"exists", "resolvedCommit", "chain"}:
        fail("tagState has unexpected fields")
    if not isinstance(tag_state.get("exists"), bool):
        fail("tagState.exists must be boolean")
    chain = tag_state.get("chain")
    if not isinstance(chain, list):
        fail("tagState.chain must be an array")
    if tag_state["exists"] is False:
        if tag_state.get("resolvedCommit") is not None or chain:
            fail("absent tagState must not claim a resolution chain")
        return tag_state
    resolved = require_sha(tag_state.get("resolvedCommit"), "tagState.resolvedCommit")
    if resolved != approved_target_sha:
        fail(f"existing tag resolves to {resolved}, expected {approved_target_sha}")
    if not chain:
        fail("existing tagState must include a resolution chain")
    for index, item in enumerate(chain):
        item = require_object(item, f"tagState.chain[{index}]")
        if set(item) != {"type", "sha"}:
            fail(f"tagState.chain[{index}] has unexpected fields")
        if item.get("type") not in {"tag", "commit"}:
            fail(f"tagState.chain[{index}] has unsupported type")
        require_sha(item.get("sha"), f"tagState.chain[{index}].sha")
    if chain[-1] != {"type": "commit", "sha": approved_target_sha}:
        fail("tagState chain does not terminate at the approved source")
    return tag_state


def build_context(event: Any, client: Client) -> dict[str, Any]:
    event_projection = validate_comment_event(event)
    pr = validate_pr(client.get_json(pull_resource()))
    files = validate_changed_files(client.get_paginated(pull_files_resource()))
    approval = ACTIVATION_VALIDATOR.load_object(
        ROOT / ACTIVATION_VALIDATOR.APPROVAL_PATH,
        "approval",
    )
    ACTIVATION_VALIDATOR.validate_approval(approval)
    tag_state = validate_tag_state(resolve_tag_state(client, approval["tag"]), approval["targetSha"])
    return {
        "schemaVersion": 1,
        "readOnly": True,
        "event": event_projection,
        "pullRequest": pr,
        "changedFiles": files,
        "tagState": tag_state,
    }


def validate_context(
    event: Any,
    context: Any,
    approval_path: Path,
    activation_path: Path,
) -> dict[str, Any]:
    event_projection = validate_comment_event(event)
    context = require_object(context, "command context")
    if set(context) != {
        "schemaVersion",
        "readOnly",
        "event",
        "pullRequest",
        "changedFiles",
        "tagState",
    }:
        fail("command context has unexpected fields")
    if context.get("schemaVersion") != 1 or context.get("readOnly") is not True:
        fail("command context schema/readOnly contract differs")
    if context.get("event") != event_projection:
        fail("command context event projection differs")
    pr = validate_pr(context.get("pullRequest"))
    files = context.get("changedFiles")
    if files != [ACTIVATION_PATH]:
        fail("command context changedFiles differs")
    approval, activation = ACTIVATION_VALIDATOR.validate_contract(
        approval_path,
        activation_path,
    )
    validate_tag_state(context.get("tagState"), approval["targetSha"])
    synthetic_event = {
        "action": "closed",
        "repository": {"full_name": REPOSITORY},
        "pull_request": pr,
    }
    try:
        ACTIVATION_VALIDATOR.validate_event(synthetic_event, files, activation)
    except ACTIVATION_VALIDATOR.ActivationError as exc:
        fail(f"activation contract failed: {exc}")
    if pr.get("merge_commit_sha") != ACTIVATION_MERGE_SHA:
        fail("activation merge SHA differs after contract validation")
    return {
        "schemaVersion": 1,
        "readOnly": True,
        "command": event_projection,
        "pullRequest": {
            "number": PR_NUMBER,
            "mergeSha": ACTIVATION_MERGE_SHA,
            "base": "main",
            "head": ACTIVATION_BRANCH,
        },
        "changedFiles": [ACTIVATION_PATH],
        "tagState": context["tagState"],
        "approval": {
            "targetSha": approval["targetSha"],
            "targetTreeSha": approval["targetTreeSha"],
            "version": approval["version"],
            "tag": approval["tag"],
            "evidence": approval["evidence"],
            "packages": approval["zedPackages"],
        },
    }


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("fetch-context", "validate"))
    parser.add_argument("--event", type=Path, required=True)
    parser.add_argument("--context", type=Path, required=True)
    parser.add_argument(
        "--approval",
        type=Path,
        default=ROOT / ACTIVATION_VALIDATOR.APPROVAL_PATH,
    )
    parser.add_argument(
        "--activation",
        type=Path,
        default=ROOT / ACTIVATION_VALIDATOR.ACTIVATION_PATH,
    )
    parser.add_argument("--api-url", default=API_DEFAULT)
    args = parser.parse_args()
    try:
        event = load_json(args.event, "issue_comment event")
        if args.command == "fetch-context":
            token = os.environ.get("SYNC_FLEET_TOKEN", "")
            context = build_context(
                event,
                GitHubClient(token, api_url=args.api_url),
            )
            write_json(args.context, context)
            print("fetched read-only publication command context")
            return 0
        context = load_json(args.context, "command context")
        result = validate_context(
            event,
            context,
            args.approval,
            args.activation,
        )
        print(json.dumps(result, sort_keys=True))
        return 0
    except (CommandError, GitHubApiError, RuntimeError) as exc:
        print(f"zed-publication-command: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
