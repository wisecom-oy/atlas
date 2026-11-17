"""Mail seeding and probing beyond `seed` and `probe`: received-style messages, large attachments,
moves and flags, and folder-tree and archive layouts read back as `{path: subjects}`.

Everything created here is named by the caller, who passes a name carrying the run marker.
"""

from __future__ import annotations

import hashlib
import zipfile
from collections.abc import Iterator
from datetime import UTC, datetime
from email import policy
from email.parser import BytesHeaderParser
from pathlib import Path
from typing import Any

import httpx

from atlas_e2e import probe
from atlas_e2e.graph import HTTP_ERROR_FLOOR, Graph, GraphError

# Graph takes an attachment in one POST only under 3 MB; anything larger needs an upload session.
LARGE_ATTACHMENT_BYTES = 4 * 1024 * 1024
# Graph advises keeping each upload-session PUT under 4 MB.
SEED_CHUNK_BYTES = 2 * 1024 * 1024
UPLOAD_TIMEOUT_SECONDS = 120.0

# The MAPI properties Atlas itself writes when it restores a message, so a seeded message has the
# shape a restored or received one has: read, not a draft, with fixed delivery and submit times.
_READ_FLAG = {"id": "Integer 0x0E07", "value": "1"}
_DELIVERY_TIME = "SystemTime 0x0E06"
_SUBMIT_TIME = "SystemTime 0x0039"

_MESSAGE_SELECT = "id,subject,flag"


def create_received_message(graph: Graph, mailbox: str, folder_id: str, subject: str) -> str:
    """Creates a non-draft, read message in a folder and returns its id.

    The payload mirrors `build_restore_payload_from_mime`, which the lifecycle suite already
    proves Graph accepts. Fixed timestamps keep the message's MIME stable between two reads.
    """
    stamp = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    created = graph.post(
        f"/users/{mailbox}/mailFolders/{folder_id}/messages",
        {
            "subject": subject,
            "body": {"contentType": "Text", "content": f"Atlas E2E fixture. {subject}"},
            "toRecipients": [{"emailAddress": {"address": mailbox}}],
            "isDraft": False,
            "singleValueExtendedProperties": [
                _READ_FLAG,
                {"id": _DELIVERY_TIME, "value": stamp},
                {"id": _SUBMIT_TIME, "value": stamp},
            ],
        },
    )
    return str(created["id"])


def attach_large_file(
    graph: Graph, mailbox: str, message_id: str, name: str, payload: bytes
) -> None:
    """Attaches a file of 3 MB or more through an upload session.

    The upload URL is pre-authenticated and Graph rejects an `Authorization` header on it, so the
    chunks go through a plain client. The URL carries a token, so it is never logged here.
    """
    session = graph.post(
        f"/users/{mailbox}/messages/{message_id}/attachments/createUploadSession",
        {"AttachmentItem": {"attachmentType": "file", "name": name, "size": len(payload)}},
    )
    upload_url = str(session["uploadUrl"])
    with httpx.Client(timeout=UPLOAD_TIMEOUT_SECONDS) as client:
        for start in range(0, len(payload), SEED_CHUNK_BYTES):
            chunk = payload[start : start + SEED_CHUNK_BYTES]
            response = client.put(
                upload_url,
                content=chunk,
                headers={
                    "Content-Type": "application/octet-stream",
                    "Content-Range": f"bytes {start}-{start + len(chunk) - 1}/{len(payload)}",
                },
            )
            if response.status_code >= HTTP_ERROR_FLOOR:
                raise GraphError(f"attachment upload PUT -> {response.status_code}")


def flag_message(graph: Graph, mailbox: str, message_id: str) -> None:
    """Sets the follow-up flag, a change Graph's message delta reports as an update."""
    graph.call(
        "PATCH",
        f"/users/{mailbox}/messages/{message_id}",
        json={"flag": {"flagStatus": "flagged"}},
    )


def move_message(graph: Graph, mailbox: str, message_id: str, folder_id: str) -> None:
    """Moves a message to another folder of the same mailbox."""
    graph.post(f"/users/{mailbox}/messages/{message_id}/move", {"destinationId": folder_id})


def folder_paths(graph: Graph, mailbox: str, root_id: str) -> dict[str, str]:
    """Every folder beneath a root as `{path relative to the root: folder id}`."""
    return dict(_walk(graph, mailbox, root_id, ""))


def _walk(graph: Graph, mailbox: str, folder_id: str, prefix: str) -> Iterator[tuple[str, str]]:
    for child in probe.child_folders(graph, mailbox, folder_id):
        path = f"{prefix}/{child['displayName']}" if prefix else str(child["displayName"])
        yield path, str(child["id"])
        yield from _walk(graph, mailbox, str(child["id"]), path)


def messages_by_path(graph: Graph, mailbox: str, root_id: str) -> dict[str, list[dict[str, Any]]]:
    """Messages of every folder beneath a root, keyed by the folder's path relative to the root."""
    return {
        path: list(
            graph.paged(
                f"/users/{mailbox}/mailFolders/{folder_id}/messages",
                **{"$select": _MESSAGE_SELECT, "$top": 100},
            )
        )
        for path, folder_id in folder_paths(graph, mailbox, root_id).items()
    }


def subjects_by_path(messages: dict[str, list[dict[str, Any]]]) -> dict[str, list[str]]:
    """Sorted subjects per folder path. A duplicate shows up as a repeated subject."""
    return {
        path: sorted(str(m.get("subject", "")) for m in found) for path, found in messages.items()
    }


def find_by_subject(
    messages: dict[str, list[dict[str, Any]]], subject: str
) -> list[tuple[str, dict[str, Any]]]:
    """Every `(path, message)` whose subject is exactly `subject`."""
    return [(p, m) for p, found in messages.items() for m in found if m.get("subject") == subject]


def flag_status(message: dict[str, Any]) -> str:
    """Graph's `flag.flagStatus`, or an empty string when the field is absent."""
    return str((message.get("flag") or {}).get("flagStatus", ""))


def attachment_sha256(graph: Graph, mailbox: str, message_id: str, name: str) -> str | None:
    """SHA-256 of a named file attachment read raw through `$value`, or None when absent.

    The raw read avoids a base64 `contentBytes` body several megabytes long.
    """
    listing = graph.paged(
        f"/users/{mailbox}/messages/{message_id}/attachments", **{"$select": "id,name"}
    )
    for attachment in listing:
        if attachment.get("name") != name:
            continue
        url = f"/users/{mailbox}/messages/{message_id}/attachments/{attachment['id']}/$value"
        response = graph.request("GET", url)
        if response.status_code >= HTTP_ERROR_FLOOR:
            raise GraphError(f"attachment $value -> {response.status_code}")
        return hashlib.sha256(response.content).hexdigest()
    return None


def archive_subjects_by_dir(archive: Path) -> dict[str, list[str]]:
    """Sorted `.eml` subjects per directory of a `save` archive, read from each Subject header."""
    layout: dict[str, list[str]] = {}
    parser = BytesHeaderParser(policy=policy.default)
    with zipfile.ZipFile(archive) as zf:
        for name in zf.namelist():
            if not name.endswith(".eml"):
                continue
            directory = name.rsplit("/", 1)[0] if "/" in name else ""
            subject = str(parser.parsebytes(zf.read(name)).get("Subject", ""))
            layout.setdefault(directory, []).append(subject)
    return {directory: sorted(subjects) for directory, subjects in layout.items()}
